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
import { Snapshot, type Point } from "@/app/snapshot";
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
  const [report, setReport] = useState<RecentScreensReport | null>(null);
  const [debug] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug"),
  );

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
  const belongsToCurrent = mark !== null && mark.capture === currentCapture;
  const pointer = belongsToCurrent ? mark.pointer : null;
  const stroke = belongsToCurrent ? mark.stroke : null;

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    sourceRef.current?.close();
    sourceRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    setStream(null);
    setKeptFocus(false);
    setScreens([]);
    setIndex(0);
    setFrozen(null);
    setMark(null);
    setAnswer(null);
    setTurns([]);
    setQuestion("");
    setReport(null);
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
      if (watched) return;
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
  }, [currentCapture]);

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
  const freeze = useCallback(async (at: Point | null): Promise<Capture | null> => {
    setError(null);
    const capture = await grabNow();
    if (!capture) return null;
    setFrozen(capture);
    setMark(at ? { capture, pointer: { kind: "point", point: at }, stroke: null } : null);
    setAnswer(null);
    setTurns([]);
    return capture;
  }, [grabNow]);

  /**
   * Where on the shared surface a click landed.
   *
   * `object-contain` letterboxes the video, so the element's box is not the
   * picture's box. Reading the position off the element directly would put
   * every mark off by the height of the bars — the exact class of quiet
   * coordinate error this project has paid for before.
   */
  const pointOnLive = useCallback((event: React.PointerEvent<HTMLVideoElement>): Point | null => {
    const video = event.currentTarget;
    if (!video.videoWidth || !video.videoHeight) return null;
    const rect = video.getBoundingClientRect();
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    const x = (event.clientX - (rect.left + (rect.width - width) / 2)) / width;
    const y = (event.clientY - (rect.top + (rect.height - height) / 2)) / height;
    // Outside the picture is the letterbox, which is not part of the screen
    // anybody means to point at.
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  }, []);

  const backToLive = useCallback(() => {
    setFrozen(null);
    setMark(null);
    setAnswer(null);
    setTurns([]);
    setQuestion("");
  }, []);

  const newTopic = useCallback(() => {
    setMark(null);
    setAnswer(null);
    setTurns([]);
    setQuestion("");
  }, []);

  const ask = useCallback(async (about?: Capture) => {
    const subject = about ?? currentCapture;
    if (!subject) return;
    if (!session) {
      setError("セッションがありません。ページを再読み込みしてください。");
      return;
    }
    const asked = question.trim();
    if (!asked && !pointer && turns.length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const imageBase64 = await withPointerMark(subject, pointer, stroke);
      const response = await askVision({
        accessToken: await accessToken(),
        imageBase64,
        mediaType: subject.mediaType,
        question: asked || undefined,
        pointer: pointer ?? undefined,
        turns,
      });
      setAnswer({ value: response, capture: subject });
      // The user's side is always recorded, even when they only pointed: a
      // history of assistant messages with nothing prompting them reads as the
      // model talking to itself, and it answers accordingly.
      setTurns((previous) => [
        ...previous,
        { role: "user" as const, text: asked || "（画面のこの場所を指した）" },
        { role: "assistant" as const, text: response.result.message },
      ]);
      setQuestion("");
    } catch (caught) {
      setError(caught instanceof GatewayError ? caught.message : "エラーが発生しました。");
    } finally {
      setBusy(false);
    }
  }, [currentCapture, session, question, pointer, stroke, turns]);

  /**
   * A question typed while the picture is live is a question about the picture
   * as it is now, so the still is taken and asked about in one movement — the
   * capture is handed straight to ask() rather than waiting for state to land.
   */
  const askAboutLive = useCallback(async () => {
    if (!question.trim()) return;
    const capture = await freeze(null);
    if (capture) await ask(capture);
  }, [question, freeze, ask]);

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
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      <header className="flex items-center gap-3 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        <span className="text-xs text-white/50">
          {watched ? "このタブから見ています" : buffered ? "共有中（画面全体）" : "共有中（ウィンドウ）"}
        </span>
        <div className="ml-auto flex shrink-0 gap-2">
          {watched && !showingLive && (
            <button onClick={backToLive} className="rounded-full bg-white/15 px-3 py-1 text-sm">
              ライブに戻る
            </button>
          )}
          {turns.length > 0 && (
            <button onClick={newTopic} className="rounded-full bg-white/15 px-3 py-1 text-sm">
              新しく聞く
            </button>
          )}
          <button onClick={stop} className="rounded-full bg-white/15 px-3 py-1 text-sm">
            共有をやめる
          </button>
        </div>
      </header>

      {debug && <DebugPanel screens={screens} report={report} index={index} buffered={buffered} watched={watched} />}

      {/* One video element for the whole life of the share, because replacing it
          drops the stream. It is the main view for a watched tab and a thumbnail
          otherwise — where it is kept only because on browsers without
          ImageCapture it is the one thing still decoding frames, and a video
          that is not displayed is not guaranteed to (docs/log.md 2026-08-15). */}
      <div className={showingLive ? "relative min-h-0 flex-1" : "relative min-h-0 flex-1 overflow-auto overscroll-contain"}>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          onPointerDown={showingLive ? (event) => void freeze(pointOnLive(event)) : undefined}
          className={
            showingLive
              ? "h-full w-full cursor-crosshair object-contain"
              : "pointer-events-none absolute bottom-2 left-2 z-10 w-12 rounded border border-white/15 opacity-30"
          }
        />

        {!showingLive && currentCapture && (
          <Snapshot
            capture={currentCapture}
            pointer={pointer}
            stroke={stroke}
            annotations={annotations}
            onPointer={point}
          />
        )}

        {!showingLive && !currentCapture && (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
            {buffered ? (
              <>
                {/* The only thing this mode ever teaches, and it is shown once:
                    after the first return there is always a screen here. */}
                <p className="text-lg font-medium">分からない画面に戻ってください</p>
                <p className="max-w-md text-sm leading-relaxed text-white/60">
                  このタブに戻ってくると、あなたが見ていた画面がここに映ります。
                  そうしたら、分からないところを指して質問してください。
                </p>
              </>
            ) : (
              <p className="text-sm text-white/60">共有した画面を読み込んでいます…</p>
            )}
            {error && <Notice tone="error">{error}</Notice>}
          </div>
        )}
      </div>

      {showingLive ? (
        <div className="shrink-0 space-y-2 bg-neutral-900/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          {error && <Notice tone="error">{error}</Notice>}
          <p className="text-xs text-white/50">
            共有したタブがここに映っています。分からないところをクリックするか、そのまま質問してください。
          </p>
          <QuestionInput value={question} onChange={setQuestion} onSubmit={askAboutLive} busy={busy} />
        </div>
      ) : (
        <>

          {buffered && screens.length > 1 && (
            <div className="shrink-0 space-y-1 px-3 pb-1">
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

          <div className="shrink-0 space-y-2 bg-neutral-900/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
            {error && <Notice tone="error">{error}</Notice>}
            {answer && <AnswerPanel answer={answer.value} />}
            <QuestionInput value={question} onChange={setQuestion} onSubmit={ask} busy={busy} />
          </div>
        </>
      )}
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
