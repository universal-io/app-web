"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import { askVision, GatewayError, type Pointer, type VisionSuccess } from "@/lib/gateway";
import {
  createFrameSource,
  messageForCaptureError,
  screenShareUnavailableReason,
  ScreenShareError,
  startScreenShare,
  type Capture,
  type DisplaySurface,
  type FrameSource,
  type Share,
} from "@/lib/screen-share";
import {
  recordRecentScreens,
  type RecentScreen,
  type RecentScreensHandle,
  type RecentScreensReport,
} from "@/lib/recent-screens";
import { withPointerMark } from "@/lib/marker";
import { accessToken, ensureSession, SessionError } from "@/lib/session";
import { Notice, Shell } from "@/app/ui";
import { markFrom, Snapshot, Stroke, type Point } from "@/app/snapshot";
import { AnswerPanel, QuestionInput } from "@/app/ask";

type Turn = { role: "user" | "assistant"; text: string };

/**
 * One machine, no second device.
 *
 * The premise of this mode is that somebody stuck on something should be able
 * to open a link and be looking at their own problem within seconds, having
 * installed nothing and learned nothing (docs/capabilities.md §1). Every
 * decision here is subordinate to that: the only thing the user is ever asked
 * to decide is which surface to share, and the only thing they are ever told is
 * to go back to the screen they were stuck on.
 *
 * What makes it work is that the screen worth asking about is never the one on
 * display when they return — it is the one from a moment earlier. That frame is
 * kept by lib/recent-screens.ts, and this page is mostly the business of
 * putting the right one of those in front of them.
 */
export default function SoloPage() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [surface, setSurface] = useState<DisplaySurface>("monitor");
  const [keptFocus, setKeptFocus] = useState(false);
  const [screens, setScreens] = useState<RecentScreen[]>([]);
  const [index, setIndex] = useState(0);
  /** Window and tab shares have no hall of mirrors, so they need no buffer:
   * the current frame is always the right one and is simply re-taken. */
  const [frozen, setFrozen] = useState<Capture | null>(null);

  /**
   * A gesture and an answer are both about one particular picture, so each is
   * stored with the picture it belongs to and read back only for that one.
   * Scoping them this way means nothing has to remember to clear them when the
   * picture changes underneath — switching candidates or taking a fresh grab
   * simply stops matching, which is the same thing without the bookkeeping to
   * get wrong.
   */
  const [mark, setMark] = useState<{ capture: Capture; pointer: Pointer | null; stroke: Point[] | null } | null>(null);
  const [answer, setAnswer] = useState<{ value: VisionSuccess; capture: Capture } | null>(null);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);
  const [report, setReport] = useState<RecentScreensReport | null>(null);
  const [debug] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug"),
  );

  const stageRef = useRef<HTMLDivElement>(null);
  const spotlightRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** null means the corner it starts in; a point means the user moved it. */
  const [panelAt, setPanelAt] = useState<{ x: number; y: number } | null>(null);
  const grabbedAt = useRef<{ dx: number; dy: number } | null>(null);
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceRef = useRef<FrameSource | null>(null);
  const recorderRef = useRef<RecentScreensHandle | null>(null);

  /**
   * Three shares, three different things the page can honestly offer.
   *
   * A tab, with focus held here, can be watched live from this page: the user
   * never leaves, so there is nothing to remember for them and nothing to come
   * back to. A window has to be brought to the front to keep redrawing, so it
   * is watched by going there and returning. A whole monitor contains this very
   * page, so it can only be seen as it was a moment ago — which is what the
   * buffer is for, and why it exists only for this one case.
   */
  const watched = surface === "browser" && keptFocus;
  const buffered = surface === "monitor";

  // Read once the session resolves, which only happens in the browser. Deciding
  // on the server would render the sharing side to every device, including the
  // phones that cannot capture a screen at all.
  const unavailable = ready ? screenShareUnavailableReason() : null;

  useEffect(() => {
    let cancelled = false;
    ensureSession()
      .then((next) => {
        if (cancelled) return;
        setSession(next);
        setReady(true);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof SessionError ? caught.message : "セッションを開始できませんでした。");
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const currentCapture: Capture | null = buffered ? (screens[index]?.capture ?? null) : frozen;
  /** Live is the default for a watched tab; a still only appears once there is
   * something to ask about, and "ライブに戻る" puts it away again. */
  const showingLive = watched && frozen === null;
  /** The shape of the box the picture lives in. Taken from whichever source is
   * showing; both describe the same surface, so it does not change between them
   * and neither does anything the user is looking at. */
  const shape = currentCapture
    ? { w: currentCapture.width, h: currentCapture.height }
    : videoSize;

  /** The picture's box: the largest one of its shape that fits the area.
   *
   * Measured rather than left to CSS. `aspect-ratio` with max-width and
   * max-height is over-constrained in this arrangement — the box has nothing
   * in flow to size it — and the version that relied on it put the still 242px
   * away from the video it replaced. Both sources describe the same surface,
   * so this box does not change when one replaces the other, and nothing the
   * user is aiming at moves. */
  const fitted = ((): { width: number; height: number } | undefined => {
    if (!shape || !stage || stage.w <= 0 || stage.h <= 0) return undefined;
    const scale = Math.min(stage.w / shape.w, stage.h / shape.h);
    return { width: Math.floor(shape.w * scale), height: Math.floor(shape.h * scale) };
  })();
  const belongsToCurrent = mark !== null && mark.capture === currentCapture;
  const pointer = belongsToCurrent ? mark.pointer : null;
  /** The wash and spotlight are up only until something has been pointed at. */
  const guiding = pointer === null;

  /**
   * Whether this window is the one the cursor is actually being reported to.
   *
   * On macOS only the key window receives continuous mouse-moved events. A
   * background window still gets the boundary events, so the cursor entering it
   * updates the light once and then it sits there — pointing confidently at
   * somewhere the cursor left long ago. A light that lies about where you are
   * is worse than no light, so while this window is not focused the spotlight
   * is dropped and the wash goes flat. The position is still recorded from
   * whatever movement does arrive, so focus returning does not make it jump.
   */
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    const sync = () => setFocused(document.hasFocus());
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);
  const stroke = belongsToCurrent ? mark.stroke : null;

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setStage({ w: width, h: height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [stream]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    sourceRef.current?.close();
    sourceRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    setStream(null);
    setKeptFocus(false);
    setVideoSize(null);
    setScreens([]);
    setIndex(0);
    setFrozen(null);
    setMark(null);
    setAnswer(null);
    setTurns([]);
    setQuestion("");
    setReport(null);
    setPanelAt(null);
  }, [stream]);

  const share = useCallback(async () => {
    setError(null);
    let share: Share;
    try {
      // A tab is the surface this mode is built around, because a tab is the
      // only one that can be watched from here without going to it. The picker
      // is asked to open there — Chrome 151 ignores the request, so it is a
      // preference and not a mechanism.
      share = await startScreenShare({ prefer: "browser" });
    } catch (caught) {
      setError(caught instanceof ScreenShareError ? caught.message : messageForCaptureError("capture-failed"));
      return;
    }
    setSurface(share.surface);
    setKeptFocus(share.keptFocus);
    setStream(share.stream);
  }, []);

  // Stopping from the browser's own bar has to end things here too, or the page
  // goes on offering screens from a share that no longer exists.
  useEffect(() => {
    if (!stream) return;
    const [track] = stream.getVideoTracks();
    const onEnded = () => stop();
    track?.addEventListener("ended", onEnded);
    return () => track?.removeEventListener("ended", onEnded);
  }, [stream, stop]);

  useEffect(() => {
    if (!stream || !videoRef.current) return;
    videoRef.current.srcObject = stream;
  }, [stream]);

  const grabNow = useCallback(async (): Promise<Capture | null> => {
    const source = sourceRef.current;
    if (!source) return null;
    // The first frame after a share begins is not always there yet, and a
    // failure here would show as an empty screen with nothing said about it.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const frame = await source.grab();
        // Window and tab shares keep no buffer, so this is the only place that
        // can report which route the frames came by. A debug panel that shows a
        // default in place of the truth is worse than one that shows nothing.
        setReport({ intervals: [], viaTrack: source.viaTrack });
        return frame.capture;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    // Running out of attempts has to say so. A blank panel that never fills is
    // the one failure nobody can act on (app-mac R11).
    setError(messageForCaptureError("capture-failed"));
    return null;
  }, []);

  useEffect(() => {
    if (!stream || !videoRef.current) return;
    const [track] = stream.getVideoTracks();
    if (!track) return;

    const source = createFrameSource(track, videoRef.current);
    sourceRef.current = source;

    if (buffered) {
      recorderRef.current = recordRecentScreens({
        source,
        onChange: (next, latest) => {
          setScreens(next);
          setReport(latest);
        },
      });
    } else if (!watched) {
      // A window share: take one now, because the user is looking at that
      // window and not at this page. A watched tab takes none — it is on screen
      // live, and freezing it before being asked would be answering a question
      // nobody put.
      void grabNow().then((capture) => capture && setFrozen(capture));
    }

    return () => {
      recorderRef.current?.stop();
      recorderRef.current = null;
      source.close();
      sourceRef.current = null;
    };
  }, [stream, buffered, watched, grabNow]);

  /**
   * Coming back to this tab is the whole interaction, so it is treated as one:
   * the newest screen is put up ready to be asked about. The answer already on
   * screen is left alone — somebody may have come back precisely to re-read it
   * — and stays readable while its boxes, which belong to the old picture, do
   * not follow it across.
   */
  useEffect(() => {
    if (!stream) return;
    function onReturn() {
      if (document.hidden) return;
      if (watched) {
        // They went to the shared tab, did something, and came back — so what
        // they want to see is how it looks now, not the still they left behind.
        // The exchange survives, because "then what?" is the usual next thing.
        setFrozen(null);
        setMark(null);
        setAnswer(null);
        return;
      }
      if (buffered) {
        setIndex(0);
      } else {
        void grabNow().then((capture) => capture && setFrozen(capture));
      }
    }
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [stream, buffered, watched, grabNow]);

  /**
   * Choosing a different screen by hand means a different subject, so the
   * exchange goes with it — the same rule as pointing somewhere new. Being
   * moved to the newest screen on returning to the tab is not that, and keeps
   * everything: coming back to re-read an answer is a normal reason to come
   * back (docs/solo-mode.md §5).
   */
  const selectCandidate = useCallback((at: number) => {
    setIndex(at);
    setMark(null);
    setAnswer(null);
    setTurns([]);
  }, []);

  useEffect(() => {
    if (!buffered || screens.length < 2) return;
    function onKey(event: KeyboardEvent) {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "ArrowLeft") selectCandidate(Math.max(0, index - 1));
      if (event.key === "ArrowRight") selectCandidate(Math.min(screens.length - 1, index + 1));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [buffered, screens.length, index, selectCandidate]);

  /**
   * One place where a question is actually sent.
   *
   * Everything is passed in rather than read from state, because the two ways a
   * question starts differ in what they know. A gesture knows the picture and
   * the mark before React has been told about either, and it is a new subject
   * so it carries no history. A typed question knows neither, and continues
   * whatever was being discussed.
   */
  const send = useCallback(async (input: {
    capture: Capture;
    pointer: Pointer | null;
    stroke: Point[] | null;
    question: string;
    history: Turn[];
  }) => {
    if (!session) {
      setError("セッションがありません。ページを再読み込みしてください。");
      return;
    }
    const asked = input.question.trim();
    if (!asked && !input.pointer) return;

    setBusy(true);
    setError(null);
    try {
      const imageBase64 = await withPointerMark(input.capture, input.pointer, input.stroke);
      const response = await askVision({
        accessToken: await accessToken(),
        imageBase64,
        mediaType: input.capture.mediaType,
        question: asked || undefined,
        pointer: input.pointer ?? undefined,
        turns: input.history,
      });
      setAnswer({ value: response, capture: input.capture });
      // The user's side is always recorded, even when they only pointed: a
      // history of assistant messages with nothing prompting them reads as the
      // model talking to itself, and it answers accordingly.
      setTurns([
        ...input.history,
        { role: "user" as const, text: asked || "（画面のこの場所を指した）" },
        { role: "assistant" as const, text: response.result.message },
      ]);
      setQuestion("");
    } catch (caught) {
      setError(caught instanceof GatewayError ? caught.message : "エラーが発生しました。");
    } finally {
      setBusy(false);
    }
  }, [session]);

  /**
   * Pointing somewhere new starts a new subject, so the previous exchange is
   * dropped. Carrying it forward made every tap return the first answer again:
   * with no typed question there was nothing in the turn to contradict the
   * history, and the model went on describing the control it had already been
   * asked about (app/watch/[roomId]/page.tsx).
   */
  const point = useCallback((next: Pointer | null, drawn: Point[] | null) => {
    if (!currentCapture) return;
    setMark({ capture: currentCapture, pointer: next, stroke: drawn });
    setAnswer(null);
    setTurns([]);
    void send({ capture: currentCapture, pointer: next, stroke: drawn, question: "", history: [] });
  }, [currentCapture, send]);

  /**
   * Stopping the live tab on the moment worth asking about.
   *
   * There is no button for this. Asking about live video cannot work — whatever
   * was pointed at has moved by the time an answer comes back — but that is our
   * problem, not something to make the user perform. So the still is taken at
   * the moment they do the thing they came to do: touch the screen, or type.
   * The gesture that froze it is carried onto the still, so a tap costs one
   * gesture rather than two.
   *
   * A new still is a new subject: the exchange so far was about a different
   * state of that page, and carrying it forward is how a model ends up
   * confidently describing something that has since scrolled away.
   */
  const freeze = useCallback(async (): Promise<Capture | null> => {
    setError(null);
    const capture = await grabNow();
    if (capture) setFrozen(capture);
    return capture;
  }, [grabNow]);

  /**
   * Drawing on the moving picture.
   *
   * The still is taken when the gesture *starts*, not when it ends, because the
   * thing being pointed at is the thing that was there when the finger went
   * down. The gesture itself keeps running over the live video and means
   * exactly what it means on a still — one finger, one stroke, tap or ring —
   * so nothing new has to be learnt for the live view.
   *
   * Nobody is asked to freeze anything. The user is both the watched and the
   * watching here, so the screen only moves when they move it, and the moment
   * worth capturing is simply the moment they act.
   */
  const [liveStroke, setLiveStroke] = useState<Point[] | null>(null);
  const pendingRef = useRef<Promise<Capture | null> | null>(null);

  /**
   * Dragging the panel out of the way.
   *
   * Kept inside the window on every move rather than only at the end: a panel
   * dropped past the edge cannot be dragged back, and there is no other way to
   * reach it.
   */
  const clampPanel = useCallback((x: number, y: number) => {
    const element = panelRef.current;
    const width = element?.offsetWidth ?? 0;
    const height = element?.offsetHeight ?? 0;
    return {
      x: Math.min(Math.max(x, 8), Math.max(8, window.innerWidth - width - 8)),
      y: Math.min(Math.max(y, 8), Math.max(8, window.innerHeight - height - 8)),
    };
  }, []);

  const onPanelDragStart = useCallback((event: React.PointerEvent) => {
    if (!event.isPrimary || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    grabbedAt.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    // Freeze it where it already is, so the first movement does not jump it
    // from the corner it was anchored to.
    setPanelAt(clampPanel(rect.left, rect.top));
  }, [clampPanel]);

  const onPanelDragMove = useCallback((event: React.PointerEvent) => {
    const grabbed = grabbedAt.current;
    if (!grabbed) return;
    setPanelAt(clampPanel(event.clientX - grabbed.dx, event.clientY - grabbed.dy));
  }, [clampPanel]);

  const onPanelDragEnd = useCallback(() => {
    grabbedAt.current = null;
  }, []);

  // A window that shrinks can strand the panel off screen, where nothing can
  // reach it. Pull it back rather than leaving the user to reload.
  useEffect(() => {
    function onResize() {
      setPanelAt((at) => (at ? clampPanel(at.x, at.y) : at));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampPanel]);

  /**
   * Moves the spotlight.
   *
   * Listened for on the window rather than on the picture, so it keeps up with
   * the cursor wherever it goes — across the margin, over the floating panel,
   * and back — instead of only while it happens to be over the one element
   * that carries the gesture handlers. A window that is visible but not focused
   * still receives hover movement, so this is also the form most likely to
   * follow the cursor when the user is working in another window.
   *
   * Written straight to the node as two custom properties. Setting React state
   * on every mouse movement would re-render the page, over live video, for
   * something purely decorative.
   */
  useEffect(() => {
    if (!guiding) return;
    function onMove(event: PointerEvent) {
      const element = spotlightRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      element.style.setProperty("--x", `${event.clientX - rect.left}px`);
      element.style.setProperty("--y", `${event.clientY - rect.top}px`);
    }
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [guiding]);

  const pointOnLive = useCallback((event: React.PointerEvent): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1),
      y: Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1),
    };
  }, []);

  const onLiveDown = useCallback((event: React.PointerEvent) => {
    // Two fingers is the browser pinching to zoom, not somebody drawing.
    if (!event.isPrimary) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pendingRef.current = grabNow();
    setLiveStroke([pointOnLive(event)]);
  }, [grabNow, pointOnLive, setLiveStroke]);

  const onLiveMove = useCallback((event: React.PointerEvent) => {
    if (!event.isPrimary) return;
    const at = pointOnLive(event);
    setLiveStroke((previous) => (previous ? [...previous, at] : previous));
  }, [pointOnLive, setLiveStroke]);

  const onLiveUp = useCallback(async () => {
    const drawn = liveStroke;
    setLiveStroke(null);
    if (!drawn || drawn.length === 0) return;
    const capture = await (pendingRef.current ?? Promise.resolve(null));
    pendingRef.current = null;
    if (!capture) return;
    const mark = markFrom(drawn);
    setFrozen(capture);
    setMark({ capture, pointer: mark.pointer, stroke: mark.stroke });
    // Pointing somewhere new is a new subject, on live video as on a still.
    setAnswer(null);
    setTurns([]);
    // And pointing at something is already the question. Waiting for a button
    // to be pressed afterwards asks the user to say twice what they said once.
    void send({ capture, pointer: mark.pointer, stroke: mark.stroke, question: "", history: [] });
  }, [liveStroke, setLiveStroke, send]);

  /**
   * Done with this subject.
   *
   * This also puts the moving picture back, which is why there is no separate
   * "back to live" button. A second button would have made "live" a mode the
   * user has to hold in their head and we would owe them an explanation of it;
   * as it is, they never learn the word. They are looking at their screen, and
   * it holds still while they ask about it.
   */
  /**
   * Start again from the screen as it is now.
   *
   * Mostly unnecessary — returning to this tab already refreshes — but without
   * it a mistaken tap leaves somebody stuck on a still with no way back, and
   * "close the tab and start over" is not an answer.
   */
  const refresh = useCallback(async () => {
    setMark(null);
    setAnswer(null);
    setTurns([]);
    setQuestion("");
    // A watched tab has a moving picture to fall back to; the others have to be
    // taken again, and clearing the still first would blank the screen.
    if (watched) setFrozen(null);
    else {
      const capture = await grabNow();
      if (capture) setFrozen(capture);
    }
  }, [watched, grabNow]);

  /** Asking about the picture already on screen, from the question box. */
  const ask = useCallback(() => {
    if (!currentCapture) return;
    void send({ capture: currentCapture, pointer, stroke, question, history: turns });
  }, [currentCapture, pointer, stroke, question, turns, send]);

  /**
   * A question typed while the picture is live is a question about the picture
   * as it is now, so the still is taken and asked about in one movement — the
   * capture is handed straight to ask() rather than waiting for state to land.
   */
  const askAboutLive = useCallback(async () => {
    if (!question.trim()) return;
    const capture = await freeze();
    if (capture) await send({ capture, pointer: null, stroke: null, question, history: turns });
  }, [question, freeze, send, turns]);

  const annotations = useMemo(
    () => (answer && answer.capture === currentCapture ? answer.value.result.annotations : []),
    [answer, currentCapture],
  );

  if (!ready) return <Shell><p className="text-slate-500">読み込み中…</p></Shell>;

  if (unavailable) {
    return (
      <Shell>
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">いま見ている画面について聞く</h1>
        </header>
        <Notice tone="warn">{messageForCaptureError(unavailable)}</Notice>
        <p className="text-sm text-slate-500">
          スマホ・タブレットからは、パソコンの画面を見る側として使えます。
        </p>
        <Link href="/" className="self-start rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600">
          パソコンの画面を見る
        </Link>
      </Shell>
    );
  }

  if (!stream) {
    return (
      <Shell>
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">説明してほしい画面を選ぶ</h1>
          <p className="text-sm text-slate-500">
            選んだ画面がこのページに映ります。分からない場所を指して質問できます。
          </p>
        </header>
        {error && <Notice tone="error">{error}</Notice>}
        <button
          onClick={share}
          className="self-start rounded-lg bg-blue-600 px-4 py-3 text-base font-medium text-white"
        >
          画面を選ぶ
        </button>
        {/* The picker's three panes are the browser's, not ours: they cannot be
            reordered or removed, and Chrome 151 ignores which one we ask it to
            open on. So the difference between them is explained here instead,
            in the order of how well each one works. */}
        <div className="space-y-2 rounded-lg bg-slate-100 px-3 py-3 text-xs leading-relaxed text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <p>
            <strong>「Chrome のタブ」から選ぶのが一番うまく動きます。</strong>
            そのタブに移動せずに、このページに映したまま見て質問できます。
          </p>
          <p>
            ウィンドウや画面全体でも使えますが、そちらは一度その画面に行って戻ってくる必要があります。
          </p>
          <p>選んだ画面のうち、あなたが質問した1枚だけが送信されます。それ以外はこのタブの中だけに置かれ、共有をやめると消えます。</p>
        </div>
        <Link href="/" className="self-start text-sm text-slate-500 underline">
          スマホやタブレットから質問する（2台で使う）
        </Link>
      </Shell>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-white text-slate-900 dark:bg-neutral-950 dark:text-white">
      {debug && <DebugPanel screens={screens} report={report} index={index} buffered={buffered} watched={watched} />}

      {/* The picture, in one box that never changes shape or position.
        Moving and held-still are the same picture in the same place — the
        still is simply laid over the video — so touching something does not
        make it jump somewhere else. An earlier version fitted the video to
        the area and then put the still in a scrolling full-width container,
        and every tap appeared to land in the wrong place because the target
        moved at the moment of the tap. */}
      <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center p-2">
        {/* Two small icons in the corner rather than a bar of labelled buttons.
            The bar cost a strip of the picture for controls nobody reaches for:
            the usual way to finish here is to close the tab. */}
        <div className="absolute right-2 top-2 z-20 flex gap-1">
          <button
            onClick={refresh}
            title="いまの画面を取り直す"
            aria-label="いまの画面を取り直す"
            className="rounded-full bg-black/40 p-2 text-white backdrop-blur transition hover:bg-black/60"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
          <button
            onClick={stop}
            title="共有をやめる"
            aria-label="共有をやめる"
            className="rounded-full bg-black/40 p-2 text-white backdrop-blur transition hover:bg-black/60"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div
          className="relative select-none"
          style={{ ...fitted, touchAction: "pinch-zoom" }}
        onPointerDown={showingLive ? onLiveDown : undefined}
        onPointerMove={showingLive ? onLiveMove : undefined}
        onPointerUp={showingLive ? () => void onLiveUp() : undefined}
        onPointerCancel={showingLive ? () => setLiveStroke(null) : undefined}
      >
        {/* Always mounted, always painted — a video that is not displayed is
            not guaranteed to decode, and on browsers without ImageCapture it
            is the only thing producing frames. When a still is up it is
            covered by it rather than hidden. */}
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          onLoadedMetadata={(event) =>
            setVideoSize({ w: event.currentTarget.videoWidth, h: event.currentTarget.videoHeight })
          }
          className="absolute inset-0 block h-full w-full"
        />

        {!showingLive && currentCapture && (
          <div className="absolute inset-0">
            <Snapshot
              capture={currentCapture}
              pointer={pointer}
              stroke={stroke}
              annotations={annotations}
              onPointer={point}
            />
          </div>
        )}

        {showingLive && liveStroke && <Stroke points={liveStroke} />}

        {/* Until something has been pointed at, the picture is indistinguishable
            from the real application — somebody seeing this for the first time
            has no way to know they are looking at a held-still copy that is
            waiting to be asked about. A wash of blue says "this is not your
            screen, it is a thing to point at", and the spotlight under the
            cursor says what to do about it. Both go the moment a pin lands,
            because by then the picture has explained itself. */}
        {guiding && (
          <div
            ref={spotlightRef}
            data-guide=""
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              // Two layers: a warm-white glow that reads as light falling on the
              // spot, over a blue wash with a soft hole punched in it. A hole
              // alone was too quiet to notice — the eye needs something to be
              // brighter, not merely less dimmed.
              background: focused
                ? [
                    // Kept faint. A stronger glow fogged the one part of the
                    // picture the user is trying to look at, which is the
                    // opposite of what a spotlight is for; the definition comes
                    // from the wash outside it, not from brightening the target.
                    "radial-gradient(circle 200px at var(--x, 50%) var(--y, 50%)," +
                      " rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.07) 45%, rgba(255,255,255,0) 80%)",
                    "radial-gradient(circle 260px at var(--x, 50%) var(--y, 50%)," +
                      " rgba(37,99,235,0) 0%, rgba(37,99,235,0) 58%," +
                      " rgba(37,99,235,0.24) 82%, rgba(37,99,235,0.24) 100%)",
                  ].join(", ")
                : "rgba(37,99,235,0.18)",
              transition: "background 200ms ease",
            }}
          />
        )}
      </div>
      </div>

      {!showingLive && !currentCapture && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center">
          {buffered ? (
            <>
              {/* The only thing this mode ever teaches, and it is shown once:
                  after the first return there is always a screen here. */}
              <p className="text-lg font-medium">分からない画面に戻ってください</p>
              <p className="mx-auto max-w-md text-sm leading-relaxed text-white/60">
                このタブに戻ってくると、あなたが見ていた画面がここに映ります。
              </p>
            </>
          ) : (
            <p className="text-sm text-white/60">共有した画面を読み込んでいます…</p>
          )}
        </div>
      )}

      {buffered && screens.length > 1 && (
        <div className="fixed bottom-4 left-4 z-30 max-w-[min(28rem,calc(100vw-28rem))] space-y-1 rounded-xl bg-neutral-900/80 p-2 text-white backdrop-blur">
          <p className="text-[11px] text-white/40">
            別の画面について聞くときは選んでください（新しい順・←→キーでも移動できます）
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {screens.map((screen, at) => (
              <button
                key={screen.id}
                onClick={() => selectCandidate(at)}
                className={`shrink-0 overflow-hidden rounded border-2 ${
                  at === index ? "border-blue-500" : "border-transparent opacity-60"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={screen.capture.dataURL} alt="" className="h-12 w-20 object-cover" draggable={false} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The panel floats instead of taking a strip along the bottom, because
          the bottom of a screenshot is part of the screenshot: a bar there
          covers exactly the thing somebody may want to ask about. Bottom-right
          is where people already expect a helper to sit, and it can be dragged
          anywhere when it is the wrong place. */}
      <div
        ref={panelRef}
        style={panelAt ? { left: panelAt.x, top: panelAt.y } : { right: 16, bottom: 16 }}
        className="fixed z-30 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/90 text-white shadow-2xl backdrop-blur"
      >
        <div
          onPointerDown={onPanelDragStart}
          onPointerMove={onPanelDragMove}
          onPointerUp={onPanelDragEnd}
          onPointerCancel={onPanelDragEnd}
          className="flex cursor-grab items-center gap-2 px-3 py-2 active:cursor-grabbing"
          style={{ touchAction: "none" }}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4 text-white/40" fill="currentColor" aria-hidden>
            <circle cx="9" cy="7" r="1.4" /><circle cx="15" cy="7" r="1.4" />
            <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
            <circle cx="9" cy="17" r="1.4" /><circle cx="15" cy="17" r="1.4" />
          </svg>
          <span className="text-xs text-white/40">ドラッグで移動できます</span>
        </div>

        <div className="space-y-2 px-3 pb-3">
          {error && <Notice tone="error">{error}</Notice>}
          {answer && <AnswerPanel answer={answer.value} />}
          {!answer && (
            <p className="text-xs text-white/50">
              分からないところをクリック、または囲んでください。そのまま質問を書いても聞けます。
            </p>
          )}
          <QuestionInput
            value={question}
            onChange={setQuestion}
            onSubmit={showingLive ? askAboutLive : ask}
            busy={busy}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * What the buffer actually did, for the one question that cannot be answered by
 * looking at the product: is a background tab still being fed frames, and are
 * two screens being told apart? Reached with `?debug` — a hypothesis about
 * either of these is worth less than one look at the numbers
 * (docs/solo-mode.md §7).
 */
function DebugPanel({
  screens,
  report,
  index,
  buffered,
  watched,
}: {
  screens: RecentScreen[];
  report: RecentScreensReport | null;
  index: number;
  buffered: boolean;
  watched: boolean;
}) {
  const gaps = report?.intervals ?? [];
  const route = report === null ? "未取得" : report.viaTrack ? "track (ImageCapture)" : "video element";
  if (!buffered) {
    // Saying "0 candidates" here would read as a buffer that found nothing,
    // when in fact these shares never needed one.
    return (
      <div className="shrink-0 border-y border-white/10 bg-black/60 px-3 py-1 font-mono text-[10px] leading-tight text-white/60">
        {watched
          ? "タブ共有・フォーカス保持あり（ライブ表示、バッファなし）"
          : "ウィンドウ共有（戻るたびに撮り直し、バッファなし）"}{" "}
        / 取得元 {route}
      </div>
    );
  }
  return (
    <div className="shrink-0 space-y-0.5 border-y border-white/10 bg-black/60 px-3 py-1 font-mono text-[10px] leading-tight text-white/60">
      <div>
        候補 {screens.length} / 選択 {index} / 取得元 {route}
      </div>
      <div>直近の取得間隔(ms): {gaps.length ? gaps.join(" ") : "—"}</div>
      <div>
        drift: {screens.map((screen) => (screen.drift === null ? "new" : screen.drift.toFixed(3))).join(" ")}
      </div>
    </div>
  );
}
