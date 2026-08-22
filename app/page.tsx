"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import QRCode from "qrcode";
import { askVision, type Pointer, type VisionSuccess } from "@/lib/gateway";
import {
  createFrameSource,
  difference,
  screenShareUnavailableReason,
  startScreenShare,
  type Capture,
  type DisplaySurface,
  type FrameSource,
  type Share,
} from "@/lib/screen-share";
import {
  recordRecentScreens,
  SAME_SCREEN,
  type RecentScreen,
  type RecentScreensHandle,
  type RecentScreensReport,
} from "@/lib/recent-screens";
import { withPointerMark } from "@/lib/marker";
import { probeSelfShare } from "@/lib/self-share";
import { createSharerPeer } from "@/lib/peer";
import { createRoomId, formatRoomId, joinRoom, type RoomConnection } from "@/lib/room";
import { accessToken, ensureProvisioned, signInWithGoogle } from "@/lib/session";
import { Account, useAccount } from "@/app/auth";
import { SiteFooter, SiteHeader } from "@/app/chrome";
import { ExplainDemo } from "@/app/demo";
import { useErrorText, usePeerErrorText } from "@/app/errors";
import { outputLanguageFor } from "@/lib/i18n/routing";
import { Join } from "@/app/join";
import { Notice, Shell, useMounted } from "@/app/ui";
import { markFrom, Snapshot, Stroke, type Point } from "@/app/snapshot";
import { ExchangeBubble, placeBeside, write, type Rect } from "@/app/bubble";
import { PULSE_STYLE, SCAN_STYLE, spotMask, WASH_STYLE } from "@/app/wash";

type Turn = { role: "user" | "assistant"; text: string };

/** The spotlight at the mirror's scale, with the long shared falloff around
 * its held-clear core (app/wash.ts). */
const SPOT_MASK = spotMask(672);

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
  const th = useTranslations("hero");
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
  /** The one held-still picture on display, whichever live surface it came
   * from: a pointed-at moment of a watched tab or monitor, a re-taken window,
   * or a buffer candidate picked by hand. Null means the live video is up. */
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
  /**
   * The model's first look at a freshly shared screen, said while live.
   *
   * Sharing is an explicit act, and it is answered like one: a single call the
   * system makes by itself, with no question and no pointer — the contract's
   * "initial observation" — whose words replace fixed usage copy in the
   * bubble. The model is looking at what was actually shared, so it can say
   * the thing this page structurally cannot know: two lines of orientation on
   * a real screen, or, when the share is this very page mirrored into itself,
   * the way out (share a window or a tab instead). Detecting the mirror here
   * with heuristics was rejected for the same reason the fixed copy is gone:
   * the page cannot see what the share shows, and the model can.
   */
  const [intro, setIntro] = useState<string | null>(null);
  /**
   * Whether this page is inside the picture it is showing (lib/self-share.ts).
   *
   * Measured, not asked about and not guessed: the wash pulses once during the
   * opening scan and the capture is watched for it. A situation with exactly
   * one right answer — you are showing yourself; pick again — is a route the
   * product takes, with words the product wrote, and a button beside them.
   * Leaving that to a model meant it came out as a description of whatever the
   * capture happened to catch, which was a coin toss between this page's own
   * front door and a hall of mirrors.
   */
  const [selfShare, setSelfShare] = useState(false);
  const [probe, setProbe] = useState<{ pulse: number; release: number; drift: number } | null>(null);
  /** Drives the wash's pulse. Read by the wash's style; written by the probe. */
  const [pulsing, setPulsing] = useState(false);
  /** The first look is in flight. Separate from `busy` because the wash and
   * the spotlight turn on what the *user* has asked, and this is the system
   * asking on its own behalf (see `guiding`). */
  const [scanning, setScanning] = useState(false);
  const [question, setQuestion] = useState("");
  /** The typed question the bubble is answering, apart from the next draft. */
  const [asked, setAsked] = useState<string | null>(null);
  /** Send-to-answer, measured where the user actually waited (pointing.md §5). */
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  /** Which send the bubble is waiting on. Closing it abandons older ones, so a
   * late answer cannot reopen a bubble the user has already put away. */
  const sendSeq = useRef(0);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);
  const [report, setReport] = useState<RecentScreensReport | null>(null);
  /** How much each sampled frame differed from the one before it, newest
   * first, and whether this tab had focus at the time. `?debug` only — see the
   * effect that fills it. */
  const [liveness, setLiveness] = useState<{ drift: number; front: boolean }[]>([]);
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
  const boxRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  /** Set once the bubble has been dragged; cleared when a new mark is made. */
  const movedRef = useRef(false);
  const grabbedAt = useRef<{ dx: number; dy: number } | null>(null);
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceRef = useRef<FrameSource | null>(null);
  const recorderRef = useRef<RecentScreensHandle | null>(null);
  /**
   * Whether the user had actually gone somewhere — the same test the recorder
   * uses, and it has to be the same one.
   *
   * This tracked `hidden` alone, to stop a mere click back into the window
   * from slapping an old still over a live picture that had recorded nothing.
   * Once the recorder went back to counting focus (lib/recent-screens.ts),
   * that reasoning inverted: going to another application *does* record now,
   * and a return from it is precisely when the kept screen is worth showing.
   * What guards the live picture is no longer this flag but the measurement
   * below — the kept screen goes up only when live is not already showing it.
   */
  const wasAwayRef = useRef(false);

  /**
   * Everything is watched live. There are only two reasons not to be.
   *
   * A tab needs focus to have been held here — otherwise the user was taken to
   * it and has to come back, and what they come back to is a still. And a
   * monitor share with a companion open must not be live *here*, because the
   * picture is being watched on the other device and a live view on this screen
   * would fold a mirror into the very stream that device receives. The words on
   * this page mean nothing to someone looking at their phone, so this page goes
   * quiet instead of instructing them.
   *
   * A window used to be excluded too, on the grounds that the OS may stop
   * drawing one that is not in front. **That was measured and it is not what
   * happens**: an unfocused window kept producing real frame-to-frame change of
   * 0.03–0.04, where a genuinely stopped source reads exactly 0.000
   * (docs/capabilities.md §4-B). It had been an assumption for as long as the
   * product existed, and it cost the one surface people reach for when they
   * want to ask about a single application.
   *
   * A monitor is live for its own reason: the hall of mirrors happens only when
   * the shared monitor is the one this page sits on, and there it is visible the
   * moment it happens, so the user can simply pick again. The buffer still
   * records while this tab is hidden, as the way back to "the screen I was just
   * looking at" for the single-monitor case.
   */
  const companionQuiet = surface === "monitor" && (companionOpen || roomId !== null);
  const watched = surface === "browser" ? keptFocus : !companionQuiet;
  /**
   * Which shares keep the recent-screens buffer.
   *
   * A monitor and a window can both be a hall of mirrors — the monitor when it
   * is the one this page sits on, the window when it is this very browser —
   * and in both, a natural way for their owner to go look at something else
   * fires `hidden` (switching tabs; for a shared browser window that is the
   * only move there is). So both record while hidden, and what they record is,
   * by construction, the screen the user went to look at. A tab share is the
   * one surface that never needs the rescue: it is always of one tab, and can
   * never show this page inside itself.
   */
  const buffered = surface !== "browser";

  // Read in the browser only: the server has no navigator, and deciding there
  // would render the sharing side to every device, including the phones that
  // cannot capture a screen at all.
  const unavailable = mounted ? screenShareUnavailableReason() : null;

  /** The held-still picture wins over the buffer: on a live monitor share the
   * still is the pointed-at moment (or a candidate picked by hand), and the
   * buffer is only the fallback the quiet companion view reads from. */
  const currentCapture: Capture | null = frozen ?? (buffered ? (screens[index]?.capture ?? null) : null);
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
  /**
   * The wash is up until *the user* has asked something — pointed at, or typed
   * into the bubble. The system's own first look does not count, and getting
   * that wrong showed: the share opened on a bare picture, and the wash arrived
   * with the answer. Backwards on both halves. The veil has to be there before
   * the words, because its job is to say "this is a picture to read, and it is
   * being read" — announcing that after the reading is finished says nothing.
   */
  const asking = busy && !scanning;
  const guiding = pointer === null && answer === null && !asking;


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
    setIntro(null);
    setScanning(false);
    setSelfShare(false);
    setProbe(null);
    setPulsing(false);
    setTurns([]);
    setQuestion("");
    setAsked(null);
    setElapsedMs(null);
    setReport(null);
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
    if (share.surface === "monitor") {
      // Chrome's "sharing this screen" bar is a separate window that takes
      // focus the moment sharing begins, which drops the spotlight before the
      // user has moved at all. Asking for focus back is best-effort — the
      // browser is free to refuse — so the spotlight's own focus handling
      // stays as the fallback.
      window.focus();
      setTimeout(() => {
        if (!document.hasFocus()) window.focus();
      }, 400);
    }
    if (intent === "companion") void openCompanion(share.stream);
  }, [accountReady, session, openCompanion, tAuth, tCap, errorText]);

  /**
   * Choose a different screen, without leaving.
   *
   * The way out of "you are sharing yourself" has to be one press. The old
   * share is ended first because Chrome will not open its picker over a live
   * one, so for a moment this page is back at its front door — which is also
   * where somebody lands if they change their mind in the picker, and a fair
   * place to be left.
   *
   * Declared after `start`: a useCallback's dependencies are read where it is
   * written, so naming `start` above its own declaration is a crash at import
   * time rather than a mistake anyone would see (see `selectCandidate`).
   */
  const repick = useCallback(async () => {
    stop();
    await start("here");
  }, [stop, start]);

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
      // The recorder holds itself back until this page has had focus once in
      // this share (lib/recent-screens.ts): until then "unfocused" means
      // Chrome's sharing bar, not the user, and recording through it offers
      // people a picture of this very page as "the page you were just on".
      recorderRef.current = recordRecentScreens({
        source,
        onChange: (next, latest) => {
          setScreens(next);
          setReport(latest);
        },
      });
    } else if (surface === "browser" && !keptFocus) {
      // The one surface that arrives already elsewhere: focus could not be held,
      // so the user is looking at the shared tab and not at this page. Take one
      // now, because they have nothing to look at here until they come back.
      // Every other surface is live and takes none — freezing before being asked
      // would be answering a question nobody put.
      //
      // Written against surface/keptFocus rather than `watched`, so opening a
      // companion mid-share cannot tear the recorder down and lose what it holds.
      void grabNow().then((capture) => capture && setFrozen(capture));
    }

    return () => {
      recorderRef.current?.stop();
      recorderRef.current = null;
      source.close();
      sourceRef.current = null;
    };
  }, [stream, buffered, surface, keptFocus, grabNow]);

  /**
   * One look, taken by the system, the moment a share begins.
   *
   * It costs one model call per share, which is a deliberate amendment to
   * "the user's explicit gesture starts every call": choosing a screen to
   * share is that gesture, and the first thing anyone wants from a copilot
   * that can see is proof that it can. It never freezes the picture and never
   * marks anything — the page stays live, the words arrive in the bubble as
   * its lead — and it seeds the history, so a question typed right after
   * continues from what was just said. Skipped when the share was started for
   * a companion device: the conversation is on the other screen, and words
   * written here are read by nobody.
   */
  const introFor = useRef<MediaStream | null>(null);
  useEffect(() => {
    if (!stream) {
      introFor.current = null;
      return;
    }
    // One chance per share, decided at the start of it. A companion opening
    // later must not fire this retroactively, and one closing must not either.
    if (introFor.current === stream) return;
    introFor.current = stream;
    if (companionOpen || roomId !== null) return;
    // The source is built by the effect above, which runs first because it is
    // declared first. Without it there is nothing to look at or to measure.
    if (!sourceRef.current) return;
    const seq = ++sendSeq.current;
    const abort = new AbortController();
    void (async () => {
      setBusy(true);
      setScanning(true);
      setError(null);

      /**
       * Two questions, asked at once, and one of them can end the other.
       *
       * "Am I looking at myself?" is measured here and settles in about a
       * second; "what is this?" is asked of the model and takes several. They
       * run together so that neither waits on the other — and if the answer to
       * the first is yes, the second stops mattering mid-flight: whatever the
       * model is composing is a description of this page's own furniture, and
       * what the user needs instead is already written down.
       */
      const asked = probeSelfShare({
        source: sourceRef.current!,
        pulse: setPulsing,
        cancelled: () => sendSeq.current !== seq,
      }).then((result) => {
        if (sendSeq.current !== seq) return result;
        setProbe(result.readings);
        if (result.selfShare) {
          setSelfShare(true);
          // Nothing the model says can be right about a picture of this page,
          // so it is not waited for and not paid attention to when it lands.
          abort.abort();
          setBusy(false);
          setScanning(false);
        }
        return result;
      });

      try {
        const capture = await grabNow();
        if (!capture || sendSeq.current !== seq) return;
        const response = await askVision({
          accessToken: await accessToken(),
          imageBase64: capture.base64,
          mediaType: capture.mediaType,
          turns: [],
          outputLanguage: outputLanguageFor(locale),
          // The opening look has nothing pointed at, so boxes would be the
          // model inventing a target.
          wantsAnnotations: false,
          signal: abort.signal,
        });
        if (sendSeq.current !== seq || abort.signal.aborted) return;
        setIntro(response.result.message);
        // Seeded as a turn so the next typed question continues from it. The
        // user's side of it is the act that actually happened.
        setTurns([
          { role: "user", text: tAsk("sharedScreen") },
          { role: "assistant", text: response.result.message },
        ]);
      } catch (caught) {
        // An answer this page cancelled is not a failure to report.
        if (sendSeq.current !== seq || abort.signal.aborted) return;
        setError(errorText(caught, tErr("generic")));
      } finally {
        await asked;
        if (sendSeq.current === seq) {
          setBusy(false);
          setScanning(false);
        }
      }
    })();
    return () => abort.abort();
  }, [stream, companionOpen, roomId, grabNow, locale, tAsk, tErr, errorText]);

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
      if (document.hidden || !document.hasFocus()) {
        wasAwayRef.current = true;
        return;
      }
      const cameBack = wasAwayRef.current;
      wasAwayRef.current = false;
      if (watched) {
        if (buffered) {
          // A live monitor or window share: coming back from hidden, the
          // screen worth asking about may be the one from a moment before
          // returning — but only when live is not already showing it. On a
          // second monitor or somebody else's window, the live picture never
          // stopped being the thing itself, and putting a still of the same
          // screen over it would demote a working live view for nothing. So
          // the newest candidate is measured against a live frame, on the
          // same line that separates two moments of one screen from two
          // screens (SAME_SCREEN — measured, not guessed). The still goes up
          // only when live shows something else — which handles the hall of
          // mirrors without ever claiming to have detected one. Merely
          // regaining focus recorded nothing and changes nothing, and the
          // exchange survives either way: coming back to re-read an answer is
          // a normal reason to come back.
          if (cameBack && screens.length > 0) {
            const newest = screens[0];
            const seqAt = sendSeq.current;
            const raise = () => {
              // A question sent in the meantime owns the view now, and so does
              // having left again before the comparison came back.
              if (sendSeq.current !== seqAt || document.hidden || !document.hasFocus()) return;
              setIndex(0);
              setFrozen(newest.capture);
            };
            const source = sourceRef.current;
            if (!source) raise();
            else
              // Grabbed a beat after the return, not at it: the first frame
              // after visibilitychange can still be of where the user was, and
              // compared that early, the kept screen and the live frame are
              // the same picture — so the rescue never fired at exactly the
              // moment it was for. Half a second is one to a few frames of any
              // real capture. If the frame is somehow still stale after that,
              // the offered thumbnails remain the way to the kept screen.
              window.setTimeout(() => {
                if (sendSeq.current !== seqAt || document.hidden || !document.hasFocus()) return;
                void source
                  .grab()
                  .then((frame) => {
                    if (difference(newest.signature, frame.signature) > SAME_SCREEN) raise();
                  })
                  // No frame to compare against: a kept screen beats a live
                  // view that cannot produce one.
                  .catch(raise);
              }, 500);
          }
          return;
        }
        // They went to the shared tab, did something, and came back — so what
        // they want to see is how it looks now, not the still they left behind.
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
    window.addEventListener("blur", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("blur", onReturn);
    };
  }, [stream, buffered, watched, screens, grabNow]);

  /**
   * Is a window share actually live? Nobody has ever measured it.
   *
   * A window is treated as never-live on the grounds that the OS may stop
   * drawing one that is covered or minimised, so a live view could sit there
   * showing a stale frame while claiming to be current. That reasoning is
   * sound and it is also **an assumption written down and never checked** —
   * docs/capabilities.md §4-B says as much in as many words, which sits badly
   * next to "測ってから決める".
   *
   * This samples the stream once a second and reports how far each frame moved
   * from the one before.
   *
   * 🔴 **A drift of 0.000 on its own proves nothing.** It says the picture did
   * not change, which is equally what a window nobody touched looks like. The
   * measurement is only decisive if the shared window is something that changes
   * *by itself* — a clock, a video, a log — because then "it stopped changing"
   * can only mean the drawing stopped. Sharing a static window and reading
   * zeroes measures the window, not the browser.
   *
   * Each sample therefore records whether this tab had focus, i.e. whether the
   * shared window was behind at the time. Zeros while behind, on a source that
   * is known to be moving, is the reading that settles it.
   *
   * `?debug` only. Nothing here runs for a user, and it is deliberately not
   * wired to any product behaviour: this is an instrument, not a feature.
   */
  useEffect(() => {
    if (!debug || !stream || surface === "monitor") return;
    let previous: Uint8ClampedArray | null = null;
    let stopped = false;
    const samples: { drift: number; front: boolean }[] = [];
    const timer = setInterval(() => {
      const source = sourceRef.current;
      if (!source) return;
      // Read before the grab resolves: by the time it does, the user may have
      // clicked back and the sample would be labelled with the wrong side.
      const front = document.hasFocus();
      void source
        .grab()
        .then((frame) => {
          if (stopped) return;
          if (previous) {
            samples.unshift({ drift: difference(previous, frame.signature), front });
            if (samples.length > 12) samples.length = 12;
            setLiveness([...samples]);
          }
          previous = frame.signature;
        })
        // One failed grab says nothing either way; the next tick tries again.
        .catch(() => {});
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [debug, stream, surface]);

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

    const seq = ++sendSeq.current;
    setBusy(true);
    setError(null);
    setAsked(asked || null);
    const started = performance.now();
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
      // A bubble closed mid-wait has said "never mind"; the late answer must
      // not reopen it.
      if (sendSeq.current !== seq) return;
      setAnswer({ value: response, capture: input.capture });
      setElapsedMs(performance.now() - started);
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
      if (sendSeq.current !== seq) return;
      setError(errorText(caught, tErr("generic")));
    } finally {
      if (sendSeq.current === seq) setBusy(false);
    }
  }, [session, tAuth, tAsk, tErr, locale, errorText]);

  /**
   * Choosing a different screen by hand means a different subject, so the
   * exchange goes with it — the same rule as pointing somewhere new. Being
   * moved to the newest screen on returning to the tab is not that, and keeps
   * everything: coming back to re-read an answer is a normal reason to come
   * back (docs/solo-mode.md §5).
   *
   * And the choice is itself a question. The bubble asks "was it this one?",
   * so answering it with a picture and nothing else reads as a control that
   * did not work — which is exactly how it read: tapping a screen appeared to
   * do nothing at all. What is asked is the most general thing there is, since
   * the user has said which screen and not yet which part of it.
   */
  const selectCandidate = useCallback((at: number) => {
    const capture = screens[at]?.capture ?? null;
    setIndex(at);
    // On a live monitor share the live picture is the default, so viewing a
    // candidate means holding it still; Esc or the margin puts it away again.
    setFrozen(capture);
    setMark(null);
    setAnswer(null);
    setTurns([]);
    if (capture) {
      void send({ capture, pointer: null, stroke: null, question: tAsk("explainScreen"), history: [] });
    }
  }, [screens, send, tAsk]);

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
   * asked about (app/companion/[roomId]/page.tsx).
   */
  const point = useCallback((next: Pointer | null, drawn: Point[] | null) => {
    if (!currentCapture) return;
    movedRef.current = false;
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
   * Done with this bubble: Esc and clicking the empty stage both land here.
   *
   * There is no drag handle and no move affordance — a bubble that sits beside
   * whatever was pointed at is moved by pointing somewhere else, which the user
   * already knows how to do. On a watched tab, putting the bubble away also
   * puts the moving picture back: the still existed only to be asked about.
   */
  const close = useCallback(() => {
    sendSeq.current += 1;
    movedRef.current = false;
    setBusy(false);
    setMark(null);
    setAnswer(null);
    setTurns([]);
    setQuestion("");
    setAsked(null);
    setError(null);
    if (watched) setFrozen(null);
  }, [watched]);

  const exchangeOpen = pointer !== null || answer !== null || busy || asked !== null;

  /**
   * Whether the corner button has somewhere to go back to.
   *
   * There is one button in that corner and it always means "back one step",
   * but the step it undoes decides what it must look like. While an
   * explanation is up, back is the picture that was being looked at before —
   * the moving one on a live surface, or simply the picture without the bubble
   * on it. With nothing left to undo, back is out of the app altogether.
   *
   * It was a ✕ in both cases, and the ✕ people actually meant was the first
   * one: they pressed it to get out of the explanation and it ended the share.
   * So the ✕ now only appears where it does that, and the way out wears a
   * house — the one irreversible thing here should look like leaving.
   */
  const backable = exchangeOpen || (watched && frozen !== null);

  /**
   * What the page has to say for itself, said from the bubble.
   *
   * Every mode has something the user needs told — what is on screen, why it
   * looks like that, what to do next — and there is exactly one place that
   * talks. While live, the title states the one fact this page knows for
   * certain (which kind of surface is shared) and the lead is the model's
   * first look at it. The fixed copy that used to teach "go to the screen you
   * want explained and come back" is gone on purpose: it described a trick
   * nobody could be expected to keep in their head, and the model, which can
   * see what was actually shared, says something better — including, when the
   * share is this page mirrored into itself, that the way to have a screen on
   * this same computer explained is to share a window or a tab instead. The
   * buffer stays, unannounced: for whoever wanders off and comes back anyway,
   * the kept screen appears and asks if it was the one they meant.
   */
  const say = ((): {
    title: string;
    lead: string;
    actions?: { id: string; label: string; onClick: () => void }[];
  } | null => {
    /**
     * The one situation with a fixed answer, so it gets a fixed answer.
     *
     * Sharing the screen this page is on can only ever show the user
     * themselves, and there is exactly one thing to do about it. That is a
     * route, not a question — the words are the product's, written once, and
     * the button that carries them out sits under them. It used to be left to
     * the model, which described the furniture of this page ("デバッグ情報が
     * 表示され、中央の大部分は空白です") because describing is what it was
     * asked to do, and what it described changed run to run depending on
     * whether the capture had caught the mirror yet.
     */
    if (selfShare) {
      return {
        title: t("mirrorTitle"),
        lead: t("mirrorLead"),
        actions: [{ id: "repick", label: t("repick"), onClick: () => void repick() }],
      };
    }
    // A still put up from the buffer and not yet asked about has to say what
    // it is: a frame kept while the user was away. Having shared the screen
    // this page sits on, live could only ever show them themselves, so the
    // buffer is a rescue — and a rescue nobody explained just looks like the
    // picture having quietly stopped following along.
    if (buffered && frozen !== null && !belongsToCurrent) {
      return { title: t("shotTitle"), lead: t("shotLead") };
    }
    const title =
      surface === "monitor"
        ? t("wholeScreenTitle")
        : surface === "window"
          ? t("windowTitle")
          : t("inviteTitle");
    return { title, lead: intro ?? t("inviteLead") };
  })();

  /** The buffer, asked as the question it has always been: was it this one?
   * It used to be a strip of thumbnails in the far corner, labelled like a
   * toolbar; the corner is where things go to be ignored, and a toolbar does
   * not tell you what it is for. */
  const offer =
    buffered && screens.length > 0
      ? {
          prompt: t("offerPrompt"),
          screens: screens.map((screen) => ({ id: screen.id, src: screen.capture.dataURL })),
          index,
          onPick: selectCandidate,
        }
      : null;

  useEffect(() => {
    if (!exchangeOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.isComposing) close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exchangeOpen, close]);

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
    movedRef.current = false;
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
    setAsked(null);
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

  /**
   * Where the anchored bubble goes.
   *
   * The pointed-at place is normalized 0-1 in the picture, and becomes pixels
   * through the box the picture actually occupies — the same conversion the
   * marks and boxes go through, read from the same element, so the bubble
   * cannot drift from the ring it belongs to (pointing.md §2.2: one
   * conversion, never a second formula). placeBeside() then keeps it off the
   * target, off the answer's own boxes, and on screen.
   */
  const placeBubble = useCallback(() => {
    const element = bubbleRef.current;
    // Dragged by hand: the hand wins until the subject changes.
    if (!element || movedRef.current) return;
    const size = { w: element.offsetWidth, h: element.offsetHeight };
    const box = boxRef.current?.getBoundingClientRect();
    if (!pointer || !box) {
      // Nothing pointed at, so nothing to sit beside: the bubble waits in the
      // bottom-right corner, where a notice with no place on the picture
      // belongs and where nothing else is.
      //
      // Not bottom-centre, which is where it used to wait: the browser's own
      // "you are sharing your screen" bar is an OS-level window floating
      // exactly there, and it covered the question box and its send button
      // outright. That bar cannot be moved or measured from a page — it is not
      // in the document — so the only remedy is to not put anything under it.
      write(element, {
        left: window.innerWidth - size.w - 24,
        top: window.innerHeight - size.h - 24,
      });
      return;
    }
    const target: Rect =
      pointer.kind === "point"
        ? {
            left: box.left + pointer.point.x * box.width - 14,
            top: box.top + pointer.point.y * box.height - 14,
            width: 28,
            height: 28,
          }
        : {
            left: box.left + pointer.region.x * box.width,
            top: box.top + pointer.region.y * box.height,
            width: pointer.region.w * box.width,
            height: pointer.region.h * box.height,
          };
    const drawn = annotations.map((annotation) => ({
      left: box.left + annotation.box.x * box.width,
      top: box.top + annotation.box.y * box.height,
      width: annotation.box.w * box.width,
      height: annotation.box.h * box.height,
    }));
    write(element, placeBeside(target, size, drawn, { w: window.innerWidth, h: window.innerHeight }));
  }, [pointer, annotations]);

  /**
   * Placed the moment the node attaches, not only when something changes.
   *
   * The layout effect below fires when `placeBubble` changes identity, and on a
   * watched tab nothing it depends on differs between "no bubble on the page"
   * and "bubble on the page": `pointer` is null either way and `annotations`
   * memoizes to the same empty array. So the effect ran once against a null
   * ref, the node arrived afterwards, and the bubble was never positioned at
   * all — it sat at 0,0 still carrying the `visibility: hidden` it mounts with,
   * which is to say the question box was simply not there.
   */
  const bubbleWatch = useRef<ResizeObserver | null>(null);
  const attachBubble = useCallback((node: HTMLDivElement | null) => {
    bubbleRef.current = node;
    bubbleWatch.current?.disconnect();
    bubbleWatch.current = null;
    if (!node) return;
    placeBubble();
    // The size watcher is wired here, in the same ref callback, and not in an
    // effect: the node appears when a share starts, which is not a moment any
    // dependency of placeBubble changes, so an effect keyed on it had already
    // run against a null ref and never came back. The waiting bubble was
    // placed once at its first size and then left there — invisible until the
    // first thing that grows it without a new mark (the system's first look),
    // which pushed its bottom out of the corner. Same trap as the initial
    // placement (log.md 2026-08-22), same remedy.
    const observer = new ResizeObserver(placeBubble);
    observer.observe(node);
    bubbleWatch.current = observer;
  }, [placeBubble]);

  // Before paint on every new mark, and again whenever the bubble changes size
  // (the answer landing) or the window does. The node mounts hidden, so it
  // never flashes at a stale position.
  useLayoutEffect(() => {
    placeBubble();
  }, [placeBubble]);

  useEffect(() => {
    window.addEventListener("resize", placeBubble);
    return () => window.removeEventListener("resize", placeBubble);
  }, [placeBubble]);

  /**
   * Moving the bubble out of the way.
   *
   * Beside the pointed-at place is the right answer often enough to be the
   * default, and not often enough to be the only option: sometimes the thing
   * you want to read is exactly where the reply landed. So it can be picked up
   * — and picking it up wins until the subject changes, at which point the
   * bubble goes back to following the mark.
   *
   * Kept inside the window on every move rather than only at the end: dropped
   * past the edge it could never be reached again.
   */
  const onGrab = useCallback((event: React.PointerEvent) => {
    const element = bubbleRef.current;
    if (!element || !event.isPrimary) return;
    const rect = element.getBoundingClientRect();
    grabbedAt.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    movedRef.current = true;
  }, []);

  const onGrabMove = useCallback((event: React.PointerEvent) => {
    const grabbed = grabbedAt.current;
    const element = bubbleRef.current;
    if (!grabbed || !element) return;
    write(element, { left: event.clientX - grabbed.dx, top: event.clientY - grabbed.dy });
  }, []);

  const onGrabEnd = useCallback(() => {
    grabbedAt.current = null;
  }, []);

  if (!mounted) return <Shell><p className="text-slate">{t("loading")}</p></Shell>;

  if (unavailable) {
    // A phone cannot capture a screen, so it is never the sharing side.
    // Leading with a share button it can only fail at makes the app look
    // broken to the very device the QR points at — so this device is offered
    // the one thing it can be here: the watching side.
    return (
      <Shell>
        <header className="space-y-2">
          {/* The same question the desktop page asks. This device cannot host
              the demo that answers it, but the voice stays one voice. */}
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">{th("title")}</h1>
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
    /**
     * The front page is the demo.
     *
     * One question, two buttons, and the chrome — nothing else. The paragraphs
     * that used to explain the product from here (which surface to pick, what
     * gets sent, why sign in) moved into the demo layer's scripts: the page's
     * premise is that pointing beats reading, so the explanations live where
     * pointing finds them. What stays as plain text is only what somebody must
     * know *before* the demo can be discovered — that the first press goes to
     * Google — and the errors.
     */
    return (
      <>
        <SiteHeader locale={locale} />
        <ExplainDemo />
        <main className="mx-auto flex w-full max-w-[900px] flex-1 flex-col items-center justify-center px-5 py-14 text-center sm:px-10">
          {(accountError || error) && (
            <div className="mb-8 w-full max-w-[480px] space-y-2 text-left">
              {accountError && <Notice tone="error">{accountError}</Notice>}
              {error && <Notice tone="error">{error}</Notice>}
            </div>
          )}
          <h1
            data-demo="headline"
            className="io-fade-up text-balance text-[44px] font-semibold leading-[1.08] tracking-[-0.035em] sm:text-[64px] sm:leading-[1.05]"
          >
            {th("title")}
          </h1>
          <p
            className="io-fade-up mt-5 max-w-[520px] text-pretty text-[17px] leading-[1.6] text-body"
            style={{ animationDelay: "0.08s" }}
          >
            {th("subtitle")}
          </p>
          <div
            className="io-fade-up mt-9 flex w-full max-w-[420px] flex-col items-stretch gap-3.5 sm:w-auto sm:max-w-none sm:flex-row sm:items-center"
            style={{ animationDelay: "0.16s" }}
          >
            <button
              data-demo="choose"
              onClick={() => void start("here")}
              disabled={!accountReady || signingIn}
              className="rounded-xl bg-ink px-7 py-[15px] text-base font-semibold text-white transition-colors hover:bg-iris disabled:opacity-50"
            >
              {signingIn ? t("goingToGoogle") : t("choose")}
            </button>
            <button
              data-demo="companion"
              onClick={() => void start("companion")}
              disabled={!accountReady || signingIn}
              className="rounded-xl border border-edge bg-white px-7 py-3.5 text-base font-semibold text-ink transition-colors hover:border-ink disabled:opacity-50"
            >
              {th("companion")}
            </button>
          </div>
          {/* Being sent to Google by a button that says nothing about it feels
              like a malfunction; one sentence ahead of time makes it the plan. */}
          {accountReady && !session && (
            <p
              className="io-fade-up mt-6 max-w-[440px] text-xs leading-relaxed text-slate"
              style={{ animationDelay: "0.24s" }}
            >
              {t("signInFirst")}
            </p>
          )}
        </main>
        <div className="mx-auto w-full max-w-[900px] px-5 pb-5 sm:px-10">
          <Account />
        </div>
        <SiteFooter locale={locale} />
      </>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-ink text-white">
      {debug && (
        <DebugPanel
          screens={screens}
          report={report}
          index={index}
          buffered={buffered}
          watched={watched}
          liveness={liveness}
          probe={probe}
          selfShare={selfShare}
        />
      )}

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
      <div
        ref={stageRef}
        onPointerDown={(event) => {
          // The stage's own padding is "outside the picture": clicking there
          // puts the bubble away (pointing.md §3). Anything on top of it — the
          // picture, the bubble, the buttons — is the event's target instead.
          if (event.target === event.currentTarget) close();
        }}
        className="relative flex min-h-0 flex-1 items-center justify-center"
      >
        {/* Two small icons in the corner rather than a bar of labelled buttons.
            The bar cost a strip of the picture for controls nobody reaches for:
            the usual way to finish here is to close the tab. */}
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1">
          {/* Which of the two things you are looking at, said out loud.
              A held-still picture and a moving one are indistinguishable when
              nothing on the shared screen happens to be moving, and the mistake
              that follows is specific: the user carries on working, expects the
              picture to follow, and reads "nothing happens" as a broken app.
              This was first shown only while live, on the theory that its
              absence marked the still — but an absence is not a label, and the
              structure stayed unreadable even to us. So both states are named,
              and the pair is what makes either legible. It sits at the near end
              of the tool group because it is a state, not a control. */}
          <span
            data-mode={showingLive ? "live" : "guide"}
            // The bubble's own material, not the tool buttons' bg-black/40:
            // this badge is the copilot speaking, and a 40%-black pill takes
            // its contrast from whatever screen happens to be underneath —
            // measured on a white page, the iris bolt on it came out at about
            // 2.4:1 and read as a smudge.
            className="mr-1 flex select-none items-center gap-1.5 rounded-full bg-carbon/90 px-2.5 py-1 text-[11px] font-medium text-white/85 backdrop-blur"
          >
            {showingLive ? (
              <svg
                viewBox="0 0 24 24"
                // Green, not iris. In the app's own accent the bolt read as
                // one more piece of chrome — an indicator the same colour as
                // every button looks switched off. Green is already what
                // "connected, right now" means here (CompanionState), so this
                // borrows a meaning rather than inventing one.
                className="h-3.5 w-3.5 animate-pulse text-green-400 motion-reduce:animate-none"
                fill="currentColor"
                aria-hidden
              >
                <path d="M13 2 4.5 13.2a.6.6 0 0 0 .48.96H10l-1 8 8.5-11.2a.6.6 0 0 0-.48-.96H12z" />
              </svg>
            ) : (
              // A page being looked at closely. Deliberately not green and not
              // iris: this state is neither live nor an action, and borrowing
              // either colour would say something untrue about it.
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 text-white/70"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M13.5 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h4" />
                <path d="M13.5 3 18 7.5V10" />
                <circle cx="16.5" cy="16.5" r="3.2" />
                <path d="m19 19 2.2 2.2" />
              </svg>
            )}
            {showingLive ? t("liveBadge") : t("guideBadge")}
          </span>
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
          {/* Back one step — see `backable`. The label says where, because the
              two destinations are not equally undoable and a tooltip is the
              cheapest place to say so before the press rather than after. */}
          <button
            onClick={backable ? close : stop}
            title={backable ? (watched ? t("backToLive") : t("closeExplanation")) : t("goHome")}
            aria-label={backable ? (watched ? t("backToLive") : t("closeExplanation")) : t("goHome")}
            className="rounded-full bg-black/40 p-2 text-white backdrop-blur transition hover:bg-black/60"
          >
            {backable ? (
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 10.5 12 3l9 7.5" />
                <path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5" />
                <path d="M9.5 21v-6h5v6" />
              </svg>
            )}
          </button>
        </div>

        <div
          ref={boxRef}
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
              thinking={busy}
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
              // The construction — backdrop dim, iris tint, dot lattice, long
              // eased falloff — lives in app/wash.ts, shared with the
              // front-page demo so the two can never drift apart. So do the
              // lessons that shaped it (why dimming is a filter, not a paint).
              ...WASH_STYLE,
              // No spotlight while the first look runs: a hole under the
              // cursor means "point here", and what is true in that moment is
              // that all of it is being looked at. The band below says that
              // instead, and the light arrives when the scan ends — which is
              // also when pointing becomes the useful thing to do.
              maskImage: focused && !scanning ? SPOT_MASK : undefined,
              WebkitMaskImage: focused && !scanning ? SPOT_MASK : undefined,
              transition: "mask-image 120ms linear",
            }}
          />
        )}

        {/* The opening scan. Over the wash rather than part of it, because it
            belongs to a moment rather than to a state — and because the wash
            is shared with the front-page demo, which has nothing to scan. */}
        {guiding && scanning && (
          <div
            data-scan=""
            aria-hidden
            className="io-scan pointer-events-none absolute inset-0"
            style={SCAN_STYLE}
          />
        )}

        {/* The page asking whether it is inside its own picture
            (lib/self-share.ts). Rendered over the scan it hides inside. */}
        {pulsing && (
          <div data-pulse="" aria-hidden className="pointer-events-none absolute inset-0" style={PULSE_STYLE} />
        )}

      </div>

      {/* A monitor share being watched on the other device. A live picture
          here would fold a mirror into the very stream that device receives,
          and any instruction written here is read by nobody — the user is
          looking at their phone. So this side says only what is true, and
          offers the one action that belongs to it. */}
      {companionQuiet && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink px-6 text-center">
          <p className="text-lg font-medium">
            {peerState === "connected" ? tc("watchingThere") : tc("waitingThere")}
          </p>
          <button
            onClick={stopCompanion}
            className="rounded-lg border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40"
          >
            {tc("watchHere")}
          </button>
        </div>
      )}
      </div>

      {!showingLive && !currentCapture && !buffered && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center">
          <p className="text-sm text-white/60">{t("loadingShared")}</p>
        </div>
      )}

      {/* The exchange, beside the thing it is about (docs/pointing.md). The
          answer used to live in a floating corner panel, and the eye had to
          travel between the ring and the panel for every reply; now the reply
          sits next to the pointed-at place, the way the front-page demo already
          answers. When nothing has been pointed at, the same bubble waits at
          the bottom centre as just its input box — a typed question with no
          mark belongs to no particular spot on the picture (§3). */}
      {!companionQuiet && (
      <div
        ref={attachBubble}
        className="fixed z-30"
        style={{ left: 0, top: 0, visibility: "hidden" }}
      >
        <ExchangeBubble
          asked={asked}
          answer={answer?.capture === currentCapture ? answer.value : null}
          elapsedMs={elapsedMs}
          busy={busy}
          error={error}
          question={question}
          onQuestion={setQuestion}
          onSubmit={showingLive ? askAboutLive : ask}
          onClose={close}
          grip={{ onGrab, onGrabMove, onGrabEnd }}
          say={say}
          offer={offer}
        />
      </div>
      )}
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
  liveness,
  probe,
  selfShare,
}: {
  screens: RecentScreen[];
  report: RecentScreensReport | null;
  index: number;
  buffered: boolean;
  watched: boolean;
  /** The self-share probe's three readings (lib/self-share.ts). The verdict is
   * only arguable if the numbers behind it can be read. */
  probe: { pulse: number; release: number; drift: number } | null;
  selfShare: boolean;
  /** Frame-to-frame drift, newest first, tagged 表/裏 by whether this tab had
   * focus. Only decisive on a window that changes by itself
   * (docs/capabilities.md §4-B). */
  liveness: { drift: number; front: boolean }[];
}) {
  const gaps = report?.intervals ?? [];
  const route = report === null ? "未取得" : report.viaTrack ? "track (ImageCapture)" : "video element";
  const probed = probe
    ? `自己共有 ${selfShare ? "YES" : "no"}（脈 ${probe.pulse.toFixed(3)} / 戻り ${probe.release.toFixed(3)} / 流れ ${probe.drift.toFixed(3)}）`
    : "自己共有 未測定";
  if (!buffered) {
    // Saying "0 candidates" here would read as a buffer that found nothing,
    // when in fact these shares never needed one.
    return (
      <div className="shrink-0 space-y-0.5 border-y border-white/10 bg-black/60 px-3 py-1 font-mono text-[10px] leading-tight text-white/60">
        <div>
          {watched
            ? "ライブ表示・バッファなし（タブ・フォーカス保持）"
            : "タブ共有・フォーカス保持なし（戻るたびに撮り直し）"}{" "}
          / 取得元 {route}
        </div>
        <div>{probed}</div>
        {/* 裏 = this tab had focus, so the shared window was behind. Zeros
            only mean something on a window that moves by itself. */}
        <div>
          動き(1秒ごとの差・裏=共有窓が背面):{" "}
          {liveness.length
            ? liveness.map((at) => `${at.drift.toFixed(3)}${at.front ? "裏" : "表"}`).join(" ")
            : "—"}
        </div>
      </div>
    );
  }
  return (
    <div className="shrink-0 space-y-0.5 border-y border-white/10 bg-black/60 px-3 py-1 font-mono text-[10px] leading-tight text-white/60">
      <div>
        候補 {screens.length} / 選択 {index} / 取得元 {route} / 表示{" "}
        {watched ? "ライブ" : "コンパニオン先"}
      </div>
      <div>直近の取得間隔(ms): {gaps.length ? gaps.join(" ") : "—"}</div>
      <div>
        drift: {screens.map((screen) => (screen.drift === null ? "new" : screen.drift.toFixed(3))).join(" ")}
      </div>
      <div>{probed}</div>
      {liveness.length > 0 && (
        <div>
          動き(1秒ごとの差・裏=共有窓が背面):{" "}
          {liveness.map((at) => `${at.drift.toFixed(3)}${at.front ? "裏" : "表"}`).join(" ")}
        </div>
      )}
    </div>
  );
}
