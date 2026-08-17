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
  surfaceOf,
  type Capture,
  type DisplaySurface,
  type FrameSource,
} from "@/lib/screen-share";
import {
  recordRecentScreens,
  type RecentScreen,
  type RecentScreensHandle,
  type RecentScreensReport,
} from "@/lib/recent-screens";
import { withPointerMark } from "@/lib/marker";
import { ensureSession, SessionError } from "@/lib/session";
import { Notice, Shell } from "@/app/ui";
import { Snapshot, type Point } from "@/app/snapshot";
import { AnswerPanel, QuestionInput } from "@/app/ask";

type Turn = { role: "user" | "assistant"; text: string };

/**
 * One machine, no second device.
 *
 * The premise of this mode is that somebody stuck on something should be able
 * to open a link and be looking at their own problem within seconds, having
 * installed nothing and learned nothing (docs/requirements-solo.md §0). Every
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
    let captured: MediaStream;
    try {
      // The whole monitor is what this mode is built around, so that is the
      // pane the picker opens on. Choosing a single window still works and is
      // handled — it is the privacy grammar people already know from meetings,
      // and correcting it would be worse than supporting it.
      captured = await startScreenShare({ prefer: "monitor" });
    } catch (caught) {
      setError(caught instanceof ScreenShareError ? caught.message : messageForCaptureError("capture-failed"));
      return;
    }
    const [track] = captured.getVideoTracks();
    if (!track) {
      captured.getTracks().forEach((each) => each.stop());
      setError(messageForCaptureError("no-video-track"));
      return;
    }
    setSurface(surfaceOf(track));
    setStream(captured);
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
        return (await source.grab()).capture;
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
    } else {
      void grabNow().then((capture) => capture && setFrozen(capture));
    }

    return () => {
      recorderRef.current?.stop();
      recorderRef.current = null;
      source.close();
      sourceRef.current = null;
    };
  }, [stream, buffered, grabNow]);

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
  }, [stream, buffered, grabNow]);

  /**
   * Choosing a different screen by hand means a different subject, so the
   * exchange goes with it — the same rule as pointing somewhere new. Being
   * moved to the newest screen on returning to the tab is not that, and keeps
   * everything: coming back to re-read an answer is a normal reason to come
   * back (docs/requirements-solo.md §2-5).
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

  const newTopic = useCallback(() => {
    setMark(null);
    setAnswer(null);
    setTurns([]);
    setQuestion("");
  }, []);

  const ask = useCallback(async () => {
    if (!currentCapture) return;
    if (!session) {
      setError("セッションがありません。ページを再読み込みしてください。");
      return;
    }
    const asked = question.trim();
    if (!asked && !pointer && turns.length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const imageBase64 = await withPointerMark(currentCapture, pointer, stroke);
      const response = await askVision({
        accessToken: session.access_token,
        imageBase64,
        mediaType: currentCapture.mediaType,
        question: asked || undefined,
        pointer: pointer ?? undefined,
        turns,
      });
      setAnswer({ value: response, capture: currentCapture });
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
          <h1 className="text-xl font-semibold">いま見ている画面について聞く</h1>
          <p className="text-sm text-slate-500">
            画面を選ぶと、その後にあなたが見ていた画面をここに映します。分からない場所を指して質問できます。
          </p>
        </header>
        {error && <Notice tone="error">{error}</Notice>}
        <button
          onClick={share}
          className="self-start rounded-lg bg-blue-600 px-4 py-3 text-base font-medium text-white"
        >
          画面を選ぶ
        </button>
        <p className="rounded-lg bg-slate-100 px-3 py-3 text-xs leading-relaxed text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          「画面全体」を選ぶのがおすすめです。映った画面のうち、あなたが選んで質問した1枚だけが送信されます。
          それ以外はこのタブの中だけに置かれ、共有をやめると消えます。
        </p>
        <Link href="/" className="self-start text-sm text-slate-500 underline">
          スマホやタブレットから質問する（2台で使う）
        </Link>
      </Shell>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      <header className="flex items-center gap-3 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        {/* Kept small but kept: on browsers without ImageCapture this element is
            the only thing still decoding frames, and a video that is not
            displayed is not guaranteed to decode (docs/inception.md §8). */}
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-16 shrink-0 rounded border border-white/15 opacity-40"
        />
        <span className="text-xs text-white/50">
          {buffered ? "共有中（画面全体）" : "共有中（ウィンドウ）"}
        </span>
        <div className="ml-auto flex shrink-0 gap-2">
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

      {debug && <DebugPanel screens={screens} report={report} index={index} />}

      {!currentCapture ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          {buffered ? (
            <>
              {/* The only thing this mode ever teaches, and it is shown once:
                  after the first return there is always a screen here instead. */}
              <p className="text-lg font-medium">分からない画面に戻ってください</p>
              <p className="max-w-md text-sm leading-relaxed text-white/60">
                このタブに戻ってくると、あなたが見ていた画面がここに映ります。
                そうしたら、分からないところを指して質問してください。
              </p>
            </>
          ) : (
            // A window share has no hall of mirrors to work around, so there is
            // nothing to ask of the user — the picture is simply on its way.
            <p className="text-sm text-white/60">共有した画面を読み込んでいます…</p>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
            <Snapshot
              capture={currentCapture}
              pointer={pointer}
              stroke={stroke}
              annotations={annotations}
              onPointer={point}
            />
          </div>

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
 * (docs/requirements-solo.md §7).
 */
function DebugPanel({
  screens,
  report,
  index,
}: {
  screens: RecentScreen[];
  report: RecentScreensReport | null;
  index: number;
}) {
  const gaps = report?.intervals ?? [];
  return (
    <div className="shrink-0 space-y-0.5 border-y border-white/10 bg-black/60 px-3 py-1 font-mono text-[10px] leading-tight text-white/60">
      <div>
        候補 {screens.length} / 選択 {index} / 取得元 {report?.viaTrack ? "track (ImageCapture)" : "video element"}
      </div>
      <div>直近の取得間隔(ms): {gaps.length ? gaps.join(" ") : "—"}</div>
      <div>
        drift: {screens.map((screen) => (screen.drift === null ? "new" : screen.drift.toFixed(3))).join(" ")}
      </div>
    </div>
  );
}
