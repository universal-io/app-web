"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { askVision, GatewayError, type Annotation, type Pointer, type VisionSuccess } from "@/lib/gateway";
import {
  captureFrame,
  messageForCaptureError,
  screenShareUnavailableReason,
  ScreenShareError,
  startScreenShare,
  type Capture,
} from "@/lib/screen-share";
import { ensureSession, SessionError } from "@/lib/session";
import { Snapshot } from "@/app/snapshot";

type Turn = { role: "user" | "assistant"; text: string };

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [pointer, setPointer] = useState<Pointer | null>(null);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState<VisionSuccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const unavailable = typeof window === "undefined" ? null : screenShareUnavailableReason();

  // The session is obtained on load and never asked for. Nothing on this page
  // is gated behind it; it exists so the Gateway can meter the request.
  useEffect(() => {
    let cancelled = false;
    ensureSession()
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof SessionError
            ? caught.message
            : "セッションを開始できませんでした。",
        );
      })
      .finally(() => {
        if (!cancelled) setAuthReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!stream || !videoRef.current) return;
    videoRef.current.srcObject = stream;
    // Stopping the share from the browser's own bar must be reflected here, or
    // the page keeps offering to capture a stream that has already ended.
    const [track] = stream.getVideoTracks();
    const onEnded = () => {
      setStream(null);
      setCapture(null);
    };
    track?.addEventListener("ended", onEnded);
    return () => track?.removeEventListener("ended", onEnded);
  }, [stream]);

  const share = useCallback(async () => {
    setError(null);
    try {
      setStream(await startScreenShare());
    } catch (caught) {
      setError(
        caught instanceof ScreenShareError
          ? caught.message
          : messageForCaptureError("capture-failed"),
      );
    }
  }, []);

  const stopSharing = useCallback(() => {
    stream?.getTracks().forEach((track) => track.stop());
    setStream(null);
    setCapture(null);
    setAnswer(null);
    setPointer(null);
    setTurns([]);
  }, [stream]);

  /** Freezes the current frame. Every question is asked about a still image, so
   * what the user pointed at cannot move between the pointing and the answer. */
  const freeze = useCallback(async () => {
    if (!videoRef.current) return;
    setError(null);
    setAnswer(null);
    setPointer(null);
    try {
      setCapture(await captureFrame(videoRef.current));
    } catch (caught) {
      setError(
        caught instanceof ScreenShareError
          ? caught.message
          : messageForCaptureError("capture-failed"),
      );
    }
  }, []);

  const ask = useCallback(async () => {
    if (!capture) return;
    if (!session) {
      // Reaching here means the anonymous sign-in failed earlier. Saying so at
      // the moment of the attempt beats a button that quietly does nothing.
      setError("セッションがありません。ページを再読み込みしてください。");
      return;
    }
    const asked = question.trim();
    // A pointer with no words is a complete question: it is somebody asking
    // about a thing they cannot name, which is the case this product exists for.
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
      setError(
        caught instanceof GatewayError ? caught.message : "エラーが発生しました。",
      );
    } finally {
      setBusy(false);
    }
  }, [capture, session, question, pointer, turns]);

  if (!authReady) {
    return <Shell><p className="text-slate-500">読み込み中…</p></Shell>;
  }

  return (
    <Shell>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">画面を見てもらう</h1>
          <p className="text-sm text-slate-500">
            共有した画面について、指して聞けます。画像も回答も保存されません。
          </p>
        </div>
        <div className="flex gap-2">
          {stream ? (
            <button onClick={stopSharing} className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600">
              共有をやめる
            </button>
          ) : (
            <button
              onClick={share}
              disabled={Boolean(unavailable)}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
            >
              画面を共有
            </button>
          )}
        </div>
      </header>

      {unavailable && (
        <Notice tone="warn">{messageForCaptureError(unavailable)}</Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      {/* Kept visible even when a frame is frozen: a live preview is the only
          proof the share is still running, and a hidden video is not
          guaranteed to decode (docs/inception.md §8). */}
      <section className={stream ? "space-y-3" : "hidden"}>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-48 rounded-lg border border-slate-200 dark:border-slate-700"
        />
        {!capture && (
          <button onClick={freeze} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">
            この画面について聞く
          </button>
        )}
      </section>

      {capture && (
        <Snapshot
          capture={capture}
          pointer={pointer}
          annotations={answer?.result.annotations ?? []}
          onPointer={setPointer}
        />
      )}

      {capture && (
        <section className="space-y-3">
          <div className="flex gap-2">
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) ask();
              }}
              placeholder="質問を入力（指すだけでも聞けます）"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"
            />
            <button
              onClick={ask}
              disabled={busy}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? "読んでいます…" : "聞く"}
            </button>
            <button onClick={freeze} className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600">
              撮り直す
            </button>
          </div>

          {answer && <AnswerPanel answer={answer} />}
        </section>
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

      {/* Injected knowledge is always shown: knowledge you cannot see is
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

function Notice({ tone, children }: { tone: "warn" | "error"; children: React.ReactNode }) {
  const styles = tone === "error"
    ? "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
    : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200";
  return <p className={`rounded-lg border px-3 py-2 text-sm ${styles}`}>{children}</p>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
      {children}
    </main>
  );
}

export type { Annotation };
