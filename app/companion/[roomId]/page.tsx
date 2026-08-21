"use client";

import { use, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Session } from "@supabase/supabase-js";
import { askVision, type Pointer, type VisionSuccess } from "@/lib/gateway";
import { captureFrame, type Capture } from "@/lib/screen-share";
import { withPointerMark } from "@/lib/marker";
import { createViewerPeer } from "@/lib/peer";
import { joinRoom, type RoomConnection } from "@/lib/room";
import { accessToken } from "@/lib/session";
import { RequireAccount } from "@/app/auth";
import { useErrorText, usePeerErrorText } from "@/app/errors";
import { outputLanguageFor } from "@/lib/i18n/routing";
import { Notice } from "@/app/ui";
import { Snapshot, type Point } from "@/app/snapshot";
import { ExchangeBubble, placeBeside, type Rect } from "@/app/bubble";

type Turn = { role: "user" | "assistant"; text: string };

/**
 * The watching side.
 *
 * The mirror fills the screen and never stops. Asking opens over it rather than
 * replacing it, so the live view is still there underneath and returning to it
 * costs nothing — the share is a continuous thing being dipped into, not a
 * sequence of separate sessions.
 *
 * Nothing is ever asked about live video: whatever was pointed at has moved by
 * the time an answer arrives. Freezing makes the question one about a still
 * image (docs/companion-mode.md §2).
 *
 * The exchange takes the same form as the solo page: a bubble beside the
 * pointed-at place, and pointing is already the question (docs/pointing.md §4).
 * The one difference is which side of the touch it sits on — a thumb covers
 * what it presses, so the bubble leads with "above, clear of the finger".
 */
export default function CompanionPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  // The phone is the side that asks, so it is the side that spends the
  // allowance — it needs the account just as much as the machine sharing.
  return (
    <RequireAccount next={`/companion/${roomId}`}>
      {(session) => <Companion roomId={roomId} session={session} />}
    </RequireAccount>
  );
}

function Companion({ roomId, session }: { roomId: string; session: Session }) {
  const locale = useLocale();
  const errorText = useErrorText();
  const peerErrorText = usePeerErrorText();
  const t = useTranslations("companion");
  const tAsk = useTranslations("ask");
  const tErr = useTranslations("error");
  const [connected, setConnected] = useState(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [pointer, setPointer] = useState<Pointer | null>(null);
  const [stroke, setStroke] = useState<Point[] | null>(null);
  const [question, setQuestion] = useState("");
  /** The typed question the bubble is answering, apart from the next draft. */
  const [asked, setAsked] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState<VisionSuccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which send the bubble is waiting on; closing it abandons older ones. */
  const sendSeq = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<RoomConnection | null>(null);
  const peerRef = useRef<ReturnType<typeof createViewerPeer> | null>(null);

  useEffect(() => {
    let closed = false;
    (async () => {
      try {
        const room = await joinRoom(roomId, (message) => {
          if (message.type === "sharer-gone") {
            setConnected(false);
            setError(t("shareEnded"));
            return;
          }
          void peerRef.current?.handleSignal(message);
        });
        if (closed) {
          await room.leave();
          return;
        }
        roomRef.current = room;
        peerRef.current = createViewerPeer(room, {
          onStream: (stream) => {
            if (videoRef.current) videoRef.current.srcObject = stream;
          },
          onStateChange: (state) => setConnected(state === "connected"),
          onFailed: (code) => setError(peerErrorText(code)),
          // A connection that came good must take its own warning down.
          onRecovered: () => setError(null),
        });
        room.send({ type: "viewer-ready" });
      } catch (caught) {
        if (!closed) setError(errorText(caught, t("cannotConnect")));
      }
    })();
    return () => {
      closed = true;
      peerRef.current?.close();
      void roomRef.current?.leave();
    };
  }, [roomId, t, errorText, peerErrorText]);

  const freeze = useCallback(async () => {
    if (!videoRef.current) return;
    setError(null);
    setAnswer(null);
    setPointer(null);
    setStroke(null);
    setTurns([]);
    setAsked(null);
    try {
      setCapture(await captureFrame(videoRef.current));
    } catch {
      setError(t("noFrameYet"));
    }
  }, [t]);

  const dismiss = useCallback(() => {
    sendSeq.current += 1;
    setBusy(false);
    setCapture(null);
    setAnswer(null);
    setPointer(null);
    setStroke(null);
    setTurns([]);
    setQuestion("");
    setAsked(null);
  }, []);

  /** Done with this bubble; the still stays, ready to be pointed at again. */
  const close = useCallback(() => {
    sendSeq.current += 1;
    setBusy(false);
    setPointer(null);
    setStroke(null);
    setAnswer(null);
    setTurns([]);
    setQuestion("");
    setAsked(null);
    setError(null);
  }, []);

  /**
   * One place where a question is actually sent — same shape as the solo
   * page's: a gesture knows its mark before React does and carries no history,
   * a typed question continues whatever was being discussed.
   */
  const send = useCallback(async (input: {
    pointer: Pointer | null;
    stroke: Point[] | null;
    question: string;
    history: Turn[];
  }) => {
    if (!capture) return;
    if (!session) {
      setError(t("noSession"));
      return;
    }
    const askedNow = input.question.trim();
    if (!askedNow && !input.pointer) return;

    const seq = ++sendSeq.current;
    setBusy(true);
    setError(null);
    setAsked(askedNow || null);
    const started = performance.now();
    try {
      const imageBase64 = await withPointerMark(capture, input.pointer, input.stroke);
      const response = await askVision({
        accessToken: await accessToken(),
        imageBase64,
        mediaType: capture.mediaType,
        question: askedNow || undefined,
        pointer: input.pointer ?? undefined,
        turns: input.history,
        outputLanguage: outputLanguageFor(locale),
      });
      // A bubble closed mid-wait has said "never mind"; the late answer must
      // not reopen it.
      if (sendSeq.current !== seq) return;
      setAnswer(response);
      setElapsedMs(performance.now() - started);
      // The user's side of the exchange is always recorded, even when they only
      // pointed: a history of assistant messages with nothing prompting them
      // reads as the model talking to itself, and it answers accordingly.
      setTurns([
        ...input.history,
        { role: "user" as const, text: askedNow || tAsk("pointedHere") },
        { role: "assistant" as const, text: response.result.message },
      ]);
      setQuestion("");
    } catch (caught) {
      if (sendSeq.current !== seq) return;
      setError(errorText(caught, tErr("generic")));
    } finally {
      if (sendSeq.current === seq) setBusy(false);
    }
  }, [capture, session, locale, t, tAsk, tErr, errorText]);

  /**
   * Pointing somewhere new starts a new subject, so the previous exchange is
   * dropped — and pointing is already the question, here as on the solo page.
   * Carrying the history forward made every tap return the first answer again:
   * with no typed question there was nothing in the turn to contradict the
   * history, and the model went on describing the control it had already been
   * asked about — even while correctly boxing the new one.
   */
  const point = useCallback((next: Pointer | null, drawn: Point[] | null) => {
    setPointer(next);
    setStroke(drawn);
    setAnswer(null);
    setTurns([]);
    setAsked(null);
    if (next) void send({ pointer: next, stroke: drawn, question: "", history: [] });
  }, [send]);

  const ask = useCallback(() => {
    void send({ pointer, stroke, question, history: turns });
  }, [send, pointer, stroke, question, turns]);

  /**
   * Where the anchored bubble goes: above the touch by a finger's height, so
   * the hand that pointed isn't covering the reply; below it when the top of
   * the picture leaves no room (docs/pointing.md §4). Same single coordinate
   * conversion as the marks — normalized point through the wrapper's box.
   */
  const placeBubble = useCallback(() => {
    const element = bubbleRef.current;
    const wrap = wrapRef.current;
    if (!element || !wrap || !pointer) return;
    const w = wrap.offsetWidth;
    const h = wrap.offsetHeight;
    const target: Rect =
      pointer.kind === "point"
        ? { left: pointer.point.x * w - 14, top: pointer.point.y * h - 14, width: 28, height: 28 }
        : {
            left: pointer.region.x * w,
            top: pointer.region.y * h,
            width: pointer.region.w * w,
            height: pointer.region.h * h,
          };
    const drawn = (answer?.result.annotations ?? []).map((annotation) => ({
      left: annotation.box.x * w,
      top: annotation.box.y * h,
      width: annotation.box.w * w,
      height: annotation.box.h * h,
    }));
    const at = placeBeside(target, { w: element.offsetWidth, h: element.offsetHeight }, drawn, { w, h }, "above");
    // Written straight to the node, like the demo's bubble: placement is a
    // DOM measurement answered with a DOM position. In the picture's own
    // coordinate space, so it scrolls and zooms with what it points beside.
    element.style.left = `${at.left}px`;
    element.style.top = `${at.top}px`;
    element.style.visibility = "visible";
  }, [pointer, answer]);

  useLayoutEffect(() => {
    if (pointer) placeBubble();
  }, [pointer, placeBubble]);

  useEffect(() => {
    const element = bubbleRef.current;
    if (!element || !pointer) return;
    const observer = new ResizeObserver(placeBubble);
    observer.observe(element);
    window.addEventListener("resize", placeBubble);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", placeBubble);
    };
  }, [pointer, placeBubble]);

  // The software keyboard takes the bottom half of the screen, and the input
  // it opened for lives inside the bubble — so when the visual viewport
  // shrinks, the bubble is brought back into what remains of it.
  useEffect(() => {
    if (!pointer) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    function onResize() {
      if (document.activeElement instanceof HTMLInputElement) {
        bubbleRef.current?.scrollIntoView({ block: "nearest" });
      }
    }
    viewport.addEventListener("resize", onResize);
    return () => viewport.removeEventListener("resize", onResize);
  }, [pointer]);

  return (
    <div className="fixed inset-0 bg-black">
      {/* The live mirror. Always mounted: remounting drops the stream, and it
          is the thing being watched. */}
      <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-contain" />

      {!capture && (
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-[max(1rem,env(safe-area-inset-top))_1rem_max(1rem,env(safe-area-inset-bottom))]">
          <div className="flex justify-end">
            <span className={`pointer-events-auto rounded-full px-3 py-1 text-xs backdrop-blur ${connected ? "bg-green-500/20 text-green-200" : "bg-white/10 text-white/70"}`}>
              {connected ? t("live") : t("waitingShort")}
            </span>
          </div>
          <div className="pointer-events-auto space-y-2">
            {error && <Notice tone="error">{error}</Notice>}
            <button
              onClick={freeze}
              disabled={!connected}
              className="w-full rounded-xl bg-iris px-4 py-4 text-base font-semibold text-white shadow-lg transition-colors active:bg-iris-deep disabled:opacity-40"
            >
              {t("askAboutThis")}
            </button>
          </div>
        </div>
      )}

      {capture && (
        // The snapshot gets the whole screen and scrolls/zooms freely; the
        // exchange rides the picture, beside the touch that started it. On a
        // phone the frozen frame is already small, and giving a fixed strip of
        // it to a text box left nothing to aim at.
        <div className="absolute inset-0 flex flex-col bg-black">
          <div className="flex items-center justify-between px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
            <span className="text-xs text-white/50">{t("pinchHint")}</span>
            <button onClick={dismiss} className="rounded-full bg-white/15 px-3 py-1 text-sm text-white">
              {t("backToLive")}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
            <div ref={wrapRef} className="relative">
              <Snapshot
                capture={capture}
                pointer={pointer}
                stroke={stroke}
                annotations={answer?.result.annotations ?? []}
                onPointer={point}
                thinking={busy}
              />
              {pointer !== null && (
                <div
                  ref={bubbleRef}
                  className="absolute z-30"
                  style={{ left: 0, top: 0, visibility: "hidden" }}
                >
                  <ExchangeBubble
                    asked={asked}
                    answer={answer}
                    elapsedMs={elapsedMs}
                    busy={busy}
                    error={error}
                    question={question}
                    onQuestion={setQuestion}
                    onSubmit={ask}
                    onClose={close}
                  />
                </div>
              )}
            </div>
          </div>

          {/* A typed question with no mark belongs to no particular spot, so
              its bubble waits at the bottom — the same resting place as the
              solo page's (docs/pointing.md §3). */}
          {pointer === null && (
            <div className="flex justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <ExchangeBubble
                asked={asked}
                answer={answer}
                elapsedMs={elapsedMs}
                busy={busy}
                error={error}
                question={question}
                onQuestion={setQuestion}
                onSubmit={ask}
                onClose={close}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
