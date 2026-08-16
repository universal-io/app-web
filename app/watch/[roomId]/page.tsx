"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { askVision, GatewayError, type Pointer, type VisionSuccess } from "@/lib/gateway";
import { captureFrame, type Capture } from "@/lib/screen-share";
import { createViewerPeer } from "@/lib/peer";
import { joinRoom, type RoomConnection } from "@/lib/room";
import { ensureSession, SessionError } from "@/lib/session";
import { Notice, Shell } from "@/app/ui";
import { Snapshot } from "@/app/snapshot";

type Turn = { role: "user" | "assistant"; text: string };

/**
 * The watching side.
 *
 * The mirror runs continuously, but nothing is ever asked about live video:
 * pointing at a moving picture fails because whatever was indicated has already
 * scrolled away by the time the answer arrives. Freezing turns the question
 * into one about a still image that cannot change underneath it — the same
 * mechanism M1 used, now fed by the other device (docs/requirements.md §10).
 */
export default function WatchPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [pointer, setPointer] = useState<Pointer | null>(null);
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
      })
      .finally(() => !cancelled && setReady(true));
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
        });
        // The sharer offers only once it knows somebody is here; announcing
        // arrival is what starts the exchange.
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
    try {
      setCapture(await captureFrame(videoRef.current));
    } catch {
      setError("映像がまだ届いていません。接続を確認してください。");
    }
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
      const response = await askVision({
        accessToken: session.access_token,
        imageBase64: capture.base64,
        mediaType: capture.mediaType,
        question: asked || undefined,
        pointer: pointer ?? undefined,
        turns,
      });
      setAnswer(response);
      setTurns((previous) => [
        ...previous,
        ...(asked ? [{ role: "user" as const, text: asked }] : []),
        { role: "assistant" as const, text: response.result.message },
      ]);
      setQuestion("");
    } catch (caught) {
      setError(caught instanceof GatewayError ? caught.message : "エラーが発生しました。");
    } finally {
      setBusy(false);
    }
  }, [capture, session, question, pointer, turns]);

  if (!ready) return <Shell><p className="text-slate-500">読み込み中…</p></Shell>;

  return (
    <Shell>
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold">共有された画面</h1>
        <span className={`text-xs ${connected ? "text-green-700 dark:text-green-400" : "text-slate-500"}`}>
          {connected ? "接続中" : "接続を待っています…"}
        </span>
      </header>

      {error && <Notice tone="error">{error}</Notice>}

      {/* The live mirror stays mounted whether or not a frame is frozen: it is
          the thing being watched, and remounting it would drop the stream. */}
      <div className={capture ? "hidden" : "space-y-3"}>
        <video ref={videoRef} autoPlay muted playsInline className="w-full rounded-xl border border-slate-200 dark:border-slate-700" />
        <button
          onClick={freeze}
          disabled={!connected}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 text-base font-medium text-white disabled:opacity-40"
        >
          この画面について聞く
        </button>
      </div>

      {capture && (
        <>
          <Snapshot
            capture={capture}
            pointer={pointer}
            annotations={answer?.result.annotations ?? []}
            onPointer={setPointer}
          />

          <div className="flex gap-2">
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) ask();
              }}
              placeholder="質問（指すだけでも聞けます）"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-base dark:border-slate-600 dark:bg-slate-800"
            />
            <button
              onClick={ask}
              disabled={busy}
              className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? "…" : "聞く"}
            </button>
          </div>

          <button
            onClick={() => {
              setCapture(null);
              setAnswer(null);
              setPointer(null);
            }}
            className="self-start text-sm text-slate-500 underline"
          >
            ライブに戻る
          </button>

          {answer && <AnswerPanel answer={answer} />}
        </>
      )}
    </Shell>
  );
}

function AnswerPanel({ answer }: { answer: VisionSuccess }) {
  const { result, meta } = answer;
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{result.message}</p>

      {result.uncertainties.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-400">
          {result.uncertainties.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}

      {meta.notices?.map((notice) => (
        <Notice key={notice.code} tone="warn">{notice.message}</Notice>
      ))}

      {/* Injected knowledge is always named: knowledge you cannot see is
          knowledge you can neither question nor correct. */}
      <div className="flex flex-wrap gap-2 text-xs text-slate-500">
        {result.skill && (
          <span className="rounded-full bg-slate-100 px-2 py-1 dark:bg-slate-800">
            使った知識: {result.skill.name}
          </span>
        )}
        {typeof meta.latency_ms === "number" && (
          <span className="rounded-full bg-slate-100 px-2 py-1 dark:bg-slate-800">
            {(meta.latency_ms / 1000).toFixed(1)}秒
          </span>
        )}
      </div>
    </div>
  );
}
