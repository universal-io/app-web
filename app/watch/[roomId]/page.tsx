"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { askVision, GatewayError, type Pointer, type VisionSuccess } from "@/lib/gateway";
import { captureFrame, type Capture } from "@/lib/screen-share";
import { withPointerMark } from "@/lib/marker";
import { createViewerPeer } from "@/lib/peer";
import { joinRoom, type RoomConnection } from "@/lib/room";
import { ensureSession, SessionError } from "@/lib/session";
import { Notice } from "@/app/ui";
import { Snapshot, type Point } from "@/app/snapshot";

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
 * image (docs/requirements.md §10).
 */
export default function WatchPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const [session, setSession] = useState<Session | null>(null);
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
    let cancelled = false;
    ensureSession()
      .then((next) => !cancelled && setSession(next))
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof SessionError ? caught.message : "セッションを開始できませんでした。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let closed = false;
    (async () => {
      try {
        const room = await joinRoom(roomId, (message) => {
          if (message.type === "sharer-gone") {
            setConnected(false);
            setError("共有が終了しました。");
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
          onFailed: setError,
          // A connection that came good must take its own warning down.
          onRecovered: () => setError(null),
        });
        room.send({ type: "viewer-ready" });
      } catch (caught) {
        if (!closed) setError(caught instanceof Error ? caught.message : "接続できませんでした。");
      }
    })();
    return () => {
      closed = true;
      peerRef.current?.close();
      void roomRef.current?.leave();
    };
  }, [roomId]);

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
      setError("映像がまだ届いていません。接続を確認してください。");
    }
  }, []);

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
      setError("セッションがありません。ページを再読み込みしてください。");
      return;
    }
    const asked = question.trim();
    if (!asked && !pointer && turns.length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const imageBase64 = await withPointerMark(capture, pointer, stroke);
      const response = await askVision({
        accessToken: session.access_token,
        imageBase64,
        mediaType: capture.mediaType,
        question: asked || undefined,
        pointer: pointer ?? undefined,
        turns,
      });
      setAnswer(response);
      // The user's side of the exchange is always recorded, even when they only
      // pointed: a history of assistant messages with nothing prompting them
      // reads as the model talking to itself, and it answers accordingly.
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
  }, [capture, session, question, pointer, stroke, turns]);

  return (
    <div className="fixed inset-0 bg-black">
      {/* The live mirror. Always mounted: remounting drops the stream, and it
          is the thing being watched. */}
      <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-contain" />

      {!capture && (
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-[max(1rem,env(safe-area-inset-top))_1rem_max(1rem,env(safe-area-inset-bottom))]">
          <div className="flex justify-end">
            <span className={`pointer-events-auto rounded-full px-3 py-1 text-xs backdrop-blur ${connected ? "bg-green-500/20 text-green-200" : "bg-white/10 text-white/70"}`}>
              {connected ? "接続中" : "接続を待っています…"}
            </span>
          </div>
          <div className="pointer-events-auto space-y-2">
            {error && <Notice tone="error">{error}</Notice>}
            <button
              onClick={freeze}
              disabled={!connected}
              className="w-full rounded-xl bg-blue-600 px-4 py-4 text-base font-medium text-white shadow-lg disabled:opacity-40"
            >
              この画面について聞く
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
            <span className="text-xs text-white/50">ピンチで拡大・指でなぞって囲めます</span>
            <button onClick={dismiss} className="rounded-full bg-white/15 px-3 py-1 text-sm text-white">
              ライブに戻る
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

          <div className="space-y-2 bg-neutral-900/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
            {error && <Notice tone="error">{error}</Notice>}
            {answer && <AnswerPanel answer={answer} />}
            <div className="flex gap-2">
              <input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) ask();
                }}
                placeholder="質問（指すだけでも聞けます）"
                className="min-w-0 flex-1 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-base text-white placeholder:text-white/40"
              />
              <button
                onClick={ask}
                disabled={busy}
                className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? "…" : "聞く"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AnswerPanel({ answer }: { answer: VisionSuccess }) {
  const { result, meta } = answer;
  return (
    <div className="max-h-48 space-y-2 overflow-y-auto rounded-xl bg-white/10 p-3 text-white">
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{result.message}</p>

      {result.uncertainties.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-300">
          {result.uncertainties.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}

      {meta.notices?.map((notice) => (
        <Notice key={notice.code} tone="warn">{notice.message}</Notice>
      ))}

      {/* Injected knowledge is always named: knowledge you cannot see is
          knowledge you can neither question nor correct. */}
      <div className="flex flex-wrap gap-2 text-xs text-white/60">
        {result.skill && <span className="rounded-full bg-white/10 px-2 py-1">使った知識: {result.skill.name}</span>}
        {typeof meta.latency_ms === "number" && (
          <span className="rounded-full bg-white/10 px-2 py-1">{(meta.latency_ms / 1000).toFixed(1)}秒</span>
        )}
      </div>
    </div>
  );
}
