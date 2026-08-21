"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
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
import { AnswerPanel, QuestionInput } from "@/app/ask";

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
  const [turns, setTurns] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState<VisionSuccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
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
    try {
      setCapture(await captureFrame(videoRef.current));
    } catch {
      setError(t("noFrameYet"));
    }
  }, [t]);

  const dismiss = useCallback(() => {
    setCapture(null);
    setAnswer(null);
    setPointer(null);
    setStroke(null);
    setTurns([]);
    setQuestion("");
  }, []);

  /**
   * Pointing somewhere new starts a new subject, so the previous exchange is
   * dropped. Carrying it forward made every tap return the first answer again:
   * with no typed question there was nothing in the turn to contradict the
   * history, and the model went on describing the control it had already been
   * asked about — even while correctly boxing the new one.
   */
  const point = useCallback((next: Pointer | null, drawn: Point[] | null) => {
    setPointer(next);
    setStroke(drawn);
    setAnswer(null);
    setTurns([]);
  }, []);

  const ask = useCallback(async () => {
    if (!capture) return;
    if (!session) {
      setError(t("noSession"));
      return;
    }
    const asked = question.trim();
    if (!asked && !pointer && turns.length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const imageBase64 = await withPointerMark(capture, pointer, stroke);
      const response = await askVision({
        accessToken: await accessToken(),
        imageBase64,
        mediaType: capture.mediaType,
        question: asked || undefined,
        pointer: pointer ?? undefined,
        turns,
        outputLanguage: outputLanguageFor(locale),
      });
      setAnswer(response);
      // The user's side of the exchange is always recorded, even when they only
      // pointed: a history of assistant messages with nothing prompting them
      // reads as the model talking to itself, and it answers accordingly.
      setTurns((previous) => [
        ...previous,
        { role: "user" as const, text: asked || tAsk("pointedHere") },
        { role: "assistant" as const, text: response.result.message },
      ]);
      setQuestion("");
    } catch (caught) {
      setError(errorText(caught, tErr("generic")));
    } finally {
      setBusy(false);
    }
  }, [capture, session, question, pointer, stroke, turns, t, tAsk, tErr, locale, errorText]);

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
        // panel floats over its bottom edge. On a phone the frozen frame is
        // already small, and giving half of it to a text box left nothing to
        // aim at.
        <div className="absolute inset-0 flex flex-col bg-black">
          <div className="flex items-center justify-between px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
            <span className="text-xs text-white/50">{t("pinchHint")}</span>
            <button onClick={dismiss} className="rounded-full bg-white/15 px-3 py-1 text-sm text-white">
              {t("backToLive")}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
            <Snapshot
              capture={capture}
              pointer={pointer}
              stroke={stroke}
              annotations={answer?.result.annotations ?? []}
              onPointer={point}
            />
          </div>

          <div className="space-y-2 bg-carbon/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
            {error && <Notice tone="error">{error}</Notice>}
            {answer && <AnswerPanel answer={answer} />}
            <QuestionInput value={question} onChange={setQuestion} onSubmit={ask} busy={busy} />
          </div>
        </div>
      )}
    </div>
  );
}
