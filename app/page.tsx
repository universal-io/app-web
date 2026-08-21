"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import QRCode from "qrcode";
import { askVision, type Pointer, type VisionSuccess } from "@/lib/gateway";
import {
  createFrameSource,
  screenShareUnavailableReason,
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
import { createSharerPeer } from "@/lib/peer";
import { createRoomId, formatRoomId, joinRoom, type RoomConnection } from "@/lib/room";
import { accessToken, ensureProvisioned, signInWithGoogle } from "@/lib/session";
import { Account, useAccount } from "@/app/auth";
import { useErrorText, usePeerErrorText } from "@/app/errors";
import { outputLanguageFor } from "@/lib/i18n/routing";
import { Join } from "@/app/join";
import { Notice, Shell, useMounted } from "@/app/ui";
import { markFrom, Snapshot, Stroke, type Point } from "@/app/snapshot";
import { AnswerPanel, QuestionInput } from "@/app/ask";

type Turn = { role: "user" | "assistant"; text: string };

/**
 * The hole the spotlight cuts in the wash.
 *
 * A held-clear core to just past half the radius, then a short ramp: an even
 * fade from the centre reads as haze rather than as a light aimed at something.
 */
const SPOT_MASK =
  "radial-gradient(circle 260px at var(--x, 50%) var(--y, 50%)," +
  " transparent 0%, transparent 56%, #000 82%, #000 100%)";

/**
 * The product. This URL is the whole thing.
 *
 * The premise is that somebody stuck on something should be able to open this
 * link and be looking at their own problem within seconds, having installed
 * nothing and learned nothing (docs/capabilities.md §1). Every decision here
 * is subordinate to that: the only thing the user is ever asked to decide is
 * which surface to share, and the only thing they are ever told is to go back
 * to the screen they were stuck on.
 *
 * What makes it work is that the screen worth asking about is never the one on
 * display when they return — it is the one from a moment earlier. That frame is
 * kept by lib/recent-screens.ts, and this page is mostly the business of
 * putting the right one of those in front of them.
 *
 * A second device is not a separate mode. "スマホ・タブレットで見る" feeds the
 * same captured stream into a room (lib/peer.ts) and everything else stays as
 * it is; the other device watches at /companion/[roomId] and asks from there.
 * And a phone opening this URL cannot capture a screen at all, so it is shown
 * the way in as the watching side instead.
 */
export default function HomePage() {
  return <Home />;
}

function Home() {
  const locale = useLocale();
  const errorText = useErrorText();
  const peerErrorText = usePeerErrorText();
  const t = useTranslations("app");
  const tCap = useTranslations("capture");
  const tc = useTranslations("companion");
  const tAuth = useTranslations("auth");
  const tAsk = useTranslations("ask");
  const tErr = useTranslations("error");
  /**
   * Signing in is asked for at the moment it is needed, not at the door.
   *
   * The page itself costs nothing to look at — only a question costs a model
   * call — so the sign-in belongs on the first action, where "why am I being
   * asked" answers itself. Somebody sent this link while stuck should see what
   * the page is before being sent to Google.
   */
  const { ready: accountReady, session, error: accountError } = useAccount();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useMounted();

  // The account has to exist before the first question, whichever way the
  // session arrived — fresh from the callback, or from storage.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    ensureProvisioned(session).catch((caught: unknown) => {
      if (cancelled) return;
      setError(errorText(caught, tAuth("failedProvision")));
    });
    return () => {
      cancelled = true;
    };
  }, [session, tAuth, errorText]);

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

  /**
   * The way onto a second device.
   *
   * The room carries the very stream already captured for this page, so opening
   * it changes nothing about what this page is doing — the buffer keeps
   * recording, the live tab keeps playing. It only means the same picture is
   * now also arriving somewhere with a hand free to point at it.
   */
  const [roomId, setRoomId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [peerState, setPeerState] = useState<RTCPeerConnectionState>("new");
  const [companionOpen, setCompanionOpen] = useState(false);
  const roomRef = useRef<RoomConnection | null>(null);
  const companionPeerRef = useRef<ReturnType<typeof createSharerPeer> | null>(null);

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

  // Read in the browser only: the server has no navigator, and deciding there
  // would render the sharing side to every device, including the phones that
  // cannot capture a screen at all.
  const unavailable = mounted ? screenShareUnavailableReason() : null;

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

  const stopCompanion = useCallback(() => {
    companionPeerRef.current?.close();
    companionPeerRef.current = null;
    roomRef.current?.send({ type: "sharer-gone" });
    void roomRef.current?.leave();
    roomRef.current = null;
    setRoomId(null);
    setQr(null);
    setPeerState("new");
    setCompanionOpen(false);
  }, []);

  const openCompanion = useCallback(async (captured: MediaStream) => {
    setCompanionOpen(true);
    if (roomRef.current) return;
    const id = createRoomId();
    try {
      const room = await joinRoom(id, (message) => {
        void companionPeerRef.current?.handleSignal(message);
      });
      roomRef.current = room;
      companionPeerRef.current = createSharerPeer(captured, room, {
        onStateChange: (state) => {
          setPeerState(state);
          // The QR did its job: the person holding the other device is now
          // looking at this screen, and the code in front of it helps nobody.
          if (state === "connected") setCompanionOpen(false);
        },
        onFailed: (code) => setError(peerErrorText(code)),
        // A connection that came good must take its own warning down.
        onRecovered: () => setError(null),
      });
      setRoomId(id);
    } catch (caught) {
      setCompanionOpen(false);
      setError(errorText(caught, tc("roomFailed")));
    }
  }, [tc, errorText, peerErrorText]);

  // Cleared by stopCompanion alongside the room it encodes, so there is no
  // moment where a QR points at a room that no longer exists.
  useEffect(() => {
    if (!roomId) return;
    const url = `${window.location.origin}/companion/${roomId}`;
    QRCode.toDataURL(url, { width: 240, margin: 1 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [roomId]);

  const stop = useCallback(() => {
    stopCompanion();
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
  }, [stream, stopCompanion]);

  const start = useCallback(async (intent: "here" | "companion") => {
    setError(null);
    if (!accountReady) return;
    // No session yet: this click becomes the trip to Google, and the callback
    // brings the user back here to press the same button signed in.
    if (!session) {
      setSigningIn(true);
      try {
        await signInWithGoogle("/");
      } catch (caught) {
        setError(errorText(caught, tAuth("failedStart")));
        setSigningIn(false);
      }
      return;
    }
    let share: Share;
    try {
      // Asking here is built around a tab — the only surface that can be
      // watched without going to it — while a second device wants the whole
      // monitor, so the person can just use the computer. Either way the
      // picker is only asked to open there: Chrome 151 ignores the request,
      // so it is a preference and not a mechanism.
      share = await startScreenShare({ prefer: intent === "companion" ? "monitor" : "browser" });
    } catch (caught) {
      setError(errorText(caught, tCap("capture-failed")));
      return;
    }
    setSurface(share.surface);
    setKeptFocus(share.keptFocus);
    setStream(share.stream);
    if (intent === "companion") void openCompanion(share.stream);
  }, [accountReady, session, openCompanion, tAuth, tCap, errorText]);

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
    setError(tCap("capture-failed"));
    return null;
  }, [tCap]);

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
      setError(tAuth("expired"));
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
        outputLanguage: outputLanguageFor(locale),
      });
      setAnswer({ value: response, capture: input.capture });
      // The user's side is always recorded, even when they only pointed: a
      // history of assistant messages with nothing prompting them reads as the
      // model talking to itself, and it answers accordingly.
      setTurns([
        ...input.history,
        { role: "user" as const, text: asked || tAsk("pointedHere") },
        { role: "assistant" as const, text: response.result.message },
      ]);
      setQuestion("");
    } catch (caught) {
      setError(errorText(caught, tErr("generic")));
    } finally {
      setBusy(false);
    }
  }, [session, tAuth, tAsk, tErr, locale, errorText]);

  /**
   * Pointing somewhere new starts a new subject, so the previous exchange is
   * dropped. Carrying it forward made every tap return the first answer again:
   * with no typed question there was nothing in the turn to contradict the
   * history, and the model went on describing the control it had already been
   * asked about (app/companion/[roomId]/page.tsx).
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

  if (!mounted) return <Shell><p className="text-slate">{t("loading")}</p></Shell>;

  if (unavailable) {
    // A phone cannot capture a screen, so it is never the sharing side.
    // Leading with a share button it can only fail at makes the app look
    // broken to the very device the QR points at — so this device is offered
    // the one thing it can be here: the watching side.
    return (
      <Shell>
        <header className="space-y-1">
          <h1 className="text-xl font-semibold tracking-[-0.02em]">{t("name")}</h1>
          <p className="text-sm text-slate">{t("tagline")}</p>
        </header>
        <Join />
        <p className="rounded-lg bg-paper px-3 py-3 text-xs leading-relaxed text-body">
          {t("noCaptureNote")}
        </p>
        <Account />
      </Shell>
    );
  }

  if (!stream) {
    return (
      <Shell>
        <header className="space-y-1">
          <h1 className="text-xl font-semibold tracking-[-0.02em]">{t("chooseTitle")}</h1>
          <p className="text-sm text-slate">{t("chooseLead")}</p>
        </header>
        {accountError && <Notice tone="error">{accountError}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <button
          onClick={() => void start("here")}
          disabled={!accountReady || signingIn}
          className="self-start rounded-[10px] bg-ink px-[18px] py-3 text-base font-semibold text-white transition-colors hover:bg-iris disabled:opacity-50"
        >
          {signingIn ? t("goingToGoogle") : t("choose")}
        </button>
        {/* Being sent to Google by a button that says nothing about it feels
            like a malfunction; one sentence ahead of time makes it the plan. */}
        {accountReady && !session && (
          <p className="text-sm text-slate">{t("signInFirst")}</p>
        )}
        {/* The picker's three panes are the browser's, not ours: they cannot be
            reordered or removed, and Chrome 151 ignores which one we ask it to
            open on. So the difference between them is explained here instead,
            in the order of how well each one works. */}
        <div className="space-y-2 rounded-lg bg-paper px-3 py-3 text-xs leading-relaxed text-body">
          <p>
            {t.rich("pickerTab", { strong: (chunks) => <strong>{chunks}</strong> })}
          </p>
          <p>{t("pickerOther")}</p>
          <p>{t("pickerPrivacy")}</p>
        </div>
        <div className="space-y-2 border-t border-line pt-6">
          <div className="space-y-1">
            <h2 className="text-base font-medium">{t("companionTitle")}</h2>
            <p className="text-sm text-slate">{t("companionLead")}</p>
          </div>
          <button
            onClick={() => void start("companion")}
            disabled={!accountReady || signingIn}
            className="rounded-[10px] border border-line px-4 py-2 text-sm font-medium text-body transition-colors hover:bg-paper disabled:opacity-50"
          >
            {t("companionShowQr")}
          </button>
        </div>
        <Account />
      </Shell>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-ink text-white">
      {debug && <DebugPanel screens={screens} report={report} index={index} buffered={buffered} watched={watched} />}

      {companionOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-2xl border border-white/10 bg-carbon p-5 text-white shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-base font-medium">{tc("modalTitle")}</h2>
              <button
                onClick={() => setCompanionOpen(false)}
                aria-label={tc("close")}
                className="rounded-full bg-white/10 px-2 py-0.5 text-sm text-white/70"
              >
                ✕
              </button>
            </div>
            {qr ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={qr} alt={tc("qrAlt")} className="mx-auto rounded-lg" />
            ) : (
              <p className="text-center text-sm text-white/60">{tc("makingQr")}</p>
            )}
            {roomId && (
              <div className="space-y-1">
                <p className="text-xs text-white/50">{tc("scanOrType")}</p>
                <code className="block rounded bg-white/10 px-3 py-2 text-center font-mono text-xl tracking-widest">
                  {formatRoomId(roomId)}
                </code>
              </div>
            )}
            <CompanionState state={peerState} />
            <p className="text-xs leading-relaxed text-white/50">{tc("autoClose")}</p>
            <button
              onClick={stopCompanion}
              className="rounded-lg border border-white/20 px-3 py-2 text-sm text-white/80"
            >
              {tc("stopConnection")}
            </button>
          </div>
        </div>
      )}

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
            title={t("retake")}
            aria-label={t("retake")}
            className="rounded-full bg-black/40 p-2 text-white backdrop-blur transition hover:bg-black/60"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
          <button
            onClick={() => {
              if (companionOpen) setCompanionOpen(false);
              else if (stream) void openCompanion(stream);
            }}
            title={t("watchOnPhone")}
            aria-label={t("watchOnPhone")}
            className="rounded-full bg-black/40 p-2 text-white backdrop-blur transition hover:bg-black/60"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <path d="M14 14h3v3h-3z" />
              <path d="M21 14v.01M14 21v.01M21 21v.01M18.5 18.5v.01" />
            </svg>
          </button>
          <button
            onClick={stop}
            title={t("stopSharing")}
            aria-label={t("stopSharing")}
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
              // Dimming, not tinting.
              //
              // This began as a translucent blue with a hole in it, and a white
              // glow in the hole to read as light. Over a dark page it inverted:
              // blue over near-black *lightens* it, so the surroundings barely
              // changed while the glow fogged the one place the user was trying
              // to look. Our own colour scheme was never the variable — the
              // brightness of somebody else's screen was, and that is not
              // something to have an opinion about.
              //
              // A backdrop filter is relative to whatever is underneath, so it
              // darkens a white page and a black one alike. The mask cuts the
              // whole overlay away inside the spot, which leaves the target
              // untouched rather than lit — nothing is added to the thing being
              // examined.
              backdropFilter: "brightness(0.72) saturate(0.85)",
              WebkitBackdropFilter: "brightness(0.72) saturate(0.85)",
              background: "rgba(91,92,255,0.16)",
              maskImage: focused ? SPOT_MASK : undefined,
              WebkitMaskImage: focused ? SPOT_MASK : undefined,
              transition: "mask-image 120ms linear",
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
              <p className="text-lg font-medium">{t("goBackTitle")}</p>
              <p className="mx-auto max-w-md text-sm leading-relaxed text-white/60">
                {t("goBackLead")}
              </p>
            </>
          ) : (
            <p className="text-sm text-white/60">{t("loadingShared")}</p>
          )}
        </div>
      )}

      {buffered && screens.length > 1 && (
        <div className="fixed bottom-4 left-4 z-30 max-w-[min(28rem,calc(100vw-28rem))] space-y-1 rounded-xl bg-carbon/80 p-2 text-white backdrop-blur">
          <p className="text-[11px] text-white/40">{t("candidates")}</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {screens.map((screen, at) => (
              <button
                key={screen.id}
                onClick={() => selectCandidate(at)}
                className={`shrink-0 overflow-hidden rounded border-2 ${
                  at === index ? "border-iris" : "border-transparent opacity-60"
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
        className="fixed z-30 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-carbon/90 text-white shadow-2xl backdrop-blur"
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
          <span className="text-xs text-white/40">{t("dragToMove")}</span>
        </div>

        <div className="space-y-2 px-3 pb-3">
          {error && <Notice tone="error">{error}</Notice>}
          {answer && <AnswerPanel answer={answer.value} />}
          {!answer && (
            <p className="text-xs text-white/50">{t("hintPoint")}</p>
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

function CompanionState({ state }: { state: RTCPeerConnectionState }) {
  const t = useTranslations("companion");
  const key: Record<RTCPeerConnectionState, string> = {
    new: "waiting",
    connecting: "connecting",
    connected: "connected",
    disconnected: "disconnected",
    failed: "failed",
    closed: "closed",
  };
  const tone = state === "connected" ? "text-green-400" : "text-white/60";
  return <p className={`text-sm ${tone}`}>{t(key[state])}</p>;
}

/**
 * What the buffer actually did, for the one question that cannot be answered by
 * looking at the product: is a background tab still being fed frames, and are
 * two screens being told apart? Reached with `?debug` — a hypothesis about
 * either of these is worth less than one look at the numbers
 * (docs/solo-mode.md §7).
 */
/* Left untranslated on purpose: the strings below are read by
   scripts/check-solo-buffer.mjs and by whoever is debugging, never by a user
   who did not type `?debug`. Putting diagnostics in the message catalogue
   would mean translating them for an audience of one. */
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
