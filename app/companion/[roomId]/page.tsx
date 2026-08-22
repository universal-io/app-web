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
import { Snapshot, Stroke, markFrom, type Point } from "@/app/snapshot";
import { ExchangeBubble, placeBeside, type Rect } from "@/app/bubble";

type Turn = { role: "user" | "assistant"; text: string };

type ViewTransform = { scale: number; x: number; y: number };
type TouchPoint = { x: number; y: number };
type TouchTool = "hand" | "pen";

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

function distance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: TouchPoint, b: TouchPoint): TouchPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

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
  const [tool, setTool] = useState<TouchTool>("hand");
  const [sourceAspect, setSourceAspect] = useState(16 / 9);
  const [liveInk, setLiveInk] = useState<Point[] | null>(null);
  /** Which send the bubble is waiting on; closing it abandons older ones. */
  const sendSeq = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const movedRef = useRef(false);
  const grabbedAt = useRef<{ dx: number; dy: number } | null>(null);
  const viewRef = useRef<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const touchesRef = useRef(new Map<number, TouchPoint>());
  const pinchRef = useRef<{
    distance: number;
    scale: number;
    content: TouchPoint;
  } | null>(null);
  const panRef = useRef<{
    pointerId: number;
    start: TouchPoint;
    view: ViewTransform;
    moved: boolean;
  } | null>(null);
  const pinchWasActiveRef = useRef(false);
  const liveStrokeRef = useRef<Point[] | null>(null);
  const liveCaptureRef = useRef<Promise<Capture> | null>(null);
  const introStartedRef = useRef(false);
  const placeBubbleRef = useRef<() => void>(() => undefined);
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
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
              void videoRef.current.play().catch(() => undefined);
            }
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
    movedRef.current = false;
  }, []);

  const stopWatching = useCallback(() => {
    sendSeq.current += 1;
    setBusy(false);
    setConnected(false);
    peerRef.current?.close();
    peerRef.current = null;
    void roomRef.current?.leave();
    roomRef.current = null;
    setError(t("shareEnded"));
  }, [t]);

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
    movedRef.current = false;
  }, []);

  /**
   * One place where a question is actually sent — same shape as the solo
   * page's: a gesture knows its mark before React does and carries no history,
   * a typed question continues whatever was being discussed.
   */
  const send = useCallback(async (input: {
    capture: Capture;
    pointer: Pointer | null;
    stroke: Point[] | null;
    question: string;
    history: Turn[];
  }) => {
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
      const imageBase64 = await withPointerMark(input.capture, input.pointer, input.stroke);
      const response = await askVision({
        accessToken: await accessToken(),
        imageBase64,
        mediaType: input.capture.mediaType,
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
  }, [session, locale, t, tAsk, tErr, errorText]);

  /**
   * Pointing somewhere new starts a new subject, so the previous exchange is
   * dropped — and pointing is already the question, here as on the solo page.
   * Carrying the history forward made every tap return the first answer again:
   * with no typed question there was nothing in the turn to contradict the
   * history, and the model went on describing the control it had already been
   * asked about — even while correctly boxing the new one.
   */
  const point = useCallback((next: Pointer | null, drawn: Point[] | null) => {
    movedRef.current = false;
    setPointer(next);
    setStroke(drawn);
    setAnswer(null);
    setTurns([]);
    setAsked(null);
    if (next && capture) {
      void send({ capture, pointer: next, stroke: drawn, question: "", history: [] });
    }
  }, [capture, send]);

  const ask = useCallback(() => {
    void (async () => {
      let subject = capture;
      if (!subject) {
        const video = videoRef.current;
        if (!video) return;
        try {
          subject = await captureFrame(video);
          setCapture(subject);
        } catch {
          setError(t("noFrameYet"));
          return;
        }
      }
      await send({ capture: subject, pointer, stroke, question, history: turns });
    })();
  }, [capture, send, pointer, stroke, question, turns, t]);

  /** The first decoded frame is described without leaving live view. It is the
   * companion equivalent of the main page's opening look: arriving is already
   * an explicit request to understand the shared screen. */
  const describeFirstFrame = useCallback(() => {
    if (introStartedRef.current) return;
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return;
    introStartedRef.current = true;
    setSourceAspect(video.videoWidth / video.videoHeight);
    void (async () => {
      const seq = ++sendSeq.current;
      setBusy(true);
      setError(null);
      setAnswer(null);
      const started = performance.now();
      try {
        const first = await captureFrame(video);
        const response = await askVision({
          accessToken: await accessToken(),
          imageBase64: first.base64,
          mediaType: first.mediaType,
          turns: [],
          outputLanguage: outputLanguageFor(locale),
          wantsAnnotations: false,
        });
        if (sendSeq.current !== seq) return;
        setAnswer(response);
        setElapsedMs(performance.now() - started);
        setTurns([
          { role: "user", text: tAsk("sharedScreen") },
          { role: "assistant", text: response.result.message },
        ]);
      } catch (caught) {
        if (sendSeq.current === seq) setError(errorText(caught, tErr("generic")));
      } finally {
        if (sendSeq.current === seq) setBusy(false);
      }
    })();
  }, [locale, tAsk, tErr, errorText]);

  /** Keep the explanation inside the part of the viewport that is genuinely
   * visible. On iOS that is smaller than the layout viewport while the
   * keyboard is open. */
  const writeBubble = useCallback((at: { left: number; top: number }) => {
    const element = bubbleRef.current;
    const viewport = viewportRef.current;
    if (!element || !viewport) return;
    const box = viewport.getBoundingClientRect();
    const visual = window.visualViewport;
    const visibleLeft = visual ? visual.offsetLeft - box.left : 0;
    const visibleTop = visual ? visual.offsetTop - box.top : 0;
    const visibleRight = visual ? visual.offsetLeft + visual.width - box.left : box.width;
    const visibleBottom = visual ? visual.offsetTop + visual.height - box.top : box.height;
    const margin = 8;
    const minLeft = Math.max(margin, visibleLeft + margin);
    const minTop = Math.max(margin, visibleTop + margin);
    const maxLeft = Math.max(minLeft, Math.min(box.width, visibleRight) - element.offsetWidth - margin);
    const maxTop = Math.max(minTop, Math.min(box.height, visibleBottom) - element.offsetHeight - margin);
    element.style.left = `${clamp(at.left, minLeft, maxLeft)}px`;
    element.style.top = `${clamp(at.top, minTop, maxTop)}px`;
    element.style.visibility = "visible";
  }, []);

  /**
   * Where the anchored bubble goes. The image may be zoomed and translated,
   * but the bubble is its unscaled sibling. Its target therefore comes from
   * the image layer's transformed client rect and is converted into the
   * viewport's local coordinates exactly once.
   */
  const placeBubble = useCallback(() => {
    const element = bubbleRef.current;
    const wrap = wrapRef.current;
    const viewport = viewportRef.current;
    if (!element || !wrap || !viewport || !pointer || movedRef.current) return;
    const imageBox = wrap.getBoundingClientRect();
    const viewportBox = viewport.getBoundingClientRect();
    const left = imageBox.left - viewportBox.left;
    const top = imageBox.top - viewportBox.top;
    const target: Rect =
      pointer.kind === "point"
        ? {
            left: left + pointer.point.x * imageBox.width - 14,
            top: top + pointer.point.y * imageBox.height - 14,
            width: 28,
            height: 28,
          }
        : {
            left: left + pointer.region.x * imageBox.width,
            top: top + pointer.region.y * imageBox.height,
            width: pointer.region.w * imageBox.width,
            height: pointer.region.h * imageBox.height,
          };
    const drawn = (answer?.result.annotations ?? []).map((annotation) => ({
      left: left + annotation.box.x * imageBox.width,
      top: top + annotation.box.y * imageBox.height,
      width: annotation.box.w * imageBox.width,
      height: annotation.box.h * imageBox.height,
    }));
    const at = placeBeside(
      target,
      { w: element.offsetWidth, h: element.offsetHeight },
      drawn,
      { w: viewport.clientWidth, h: viewport.clientHeight },
      "above",
    );
    writeBubble(at);
  }, [pointer, answer, writeBubble]);

  useLayoutEffect(() => {
    placeBubbleRef.current = placeBubble;
  }, [placeBubble]);

  /** Apply the transform directly: pinch frames are transient interaction
   * state and should not re-render the answer form dozens of times a second. */
  const applyView = useCallback((next: ViewTransform) => {
    const viewport = viewportRef.current;
    const wrap = wrapRef.current;
    if (!viewport || !wrap) return;
    const scale = clamp(next.scale, MIN_ZOOM, MAX_ZOOM);
    const width = wrap.offsetWidth * scale;
    const height = wrap.offsetHeight * scale;
    const x = width <= viewport.clientWidth
      ? (viewport.clientWidth - width) / 2
      : clamp(next.x, viewport.clientWidth - width, 0);
    const y = height <= viewport.clientHeight
      ? (viewport.clientHeight - height) / 2
      : clamp(next.y, viewport.clientHeight - height, 0);
    viewRef.current = { scale, x, y };
    wrap.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    placeBubbleRef.current();
  }, []);

  const fitImageLayer = useCallback(() => {
    const viewport = viewportRef.current;
    const wrap = wrapRef.current;
    if (!viewport || !wrap) return;
    const width = Math.min(viewport.clientWidth, viewport.clientHeight * sourceAspect);
    const height = width / sourceAspect;
    wrap.style.width = `${width}px`;
    wrap.style.height = `${height}px`;
  }, [sourceAspect]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const wrap = wrapRef.current;
    if (!viewport || !wrap) return;
    fitImageLayer();
    viewRef.current = { scale: 1, x: 0, y: 0 };
    applyView(viewRef.current);
    const observer = new ResizeObserver(() => {
      fitImageLayer();
      applyView(viewRef.current);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [sourceAspect, fitImageLayer, applyView]);

  const pointInImage = useCallback((clientX: number, clientY: number): Point | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const box = wrap.getBoundingClientRect();
    if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return null;
    return {
      x: clamp((clientX - box.left) / box.width, 0, 1),
      y: clamp((clientY - box.top) / box.height, 0, 1),
    };
  }, []);

  const openCapturedMark = useCallback(async (
    subjectPromise: Promise<Capture>,
    next: Pointer,
    drawn: Point[] | null,
  ) => {
    try {
      const subject = await subjectPromise;
      setCapture(subject);
      setSourceAspect(subject.width / subject.height);
      setPointer(next);
      setStroke(drawn);
      setAnswer(null);
      setTurns([]);
      setAsked(null);
      movedRef.current = false;
      await send({ capture: subject, pointer: next, stroke: drawn, question: "", history: [] });
    } catch {
      setError(t("noFrameYet"));
    }
  }, [send, t]);

  const onImagePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    const viewport = viewportRef.current;
    if (!wrap || !viewport || !wrap.contains(event.target as Node)) return;
    const touch = { x: event.clientX, y: event.clientY };
    touchesRef.current.set(event.pointerId, touch);
    if (!capture) event.currentTarget.setPointerCapture(event.pointerId);
    if (touchesRef.current.size === 1 && tool === "hand") {
      panRef.current = {
        pointerId: event.pointerId,
        start: touch,
        view: { ...viewRef.current },
        moved: false,
      };
    }
    if (!capture && touchesRef.current.size === 1 && tool === "pen") {
      const start = pointInImage(event.clientX, event.clientY);
      if (start && videoRef.current) {
        liveStrokeRef.current = [start];
        setLiveInk([start]);
        liveCaptureRef.current = captureFrame(videoRef.current);
      }
    }
    if (touchesRef.current.size !== 2) return;
    pinchWasActiveRef.current = true;
    liveStrokeRef.current = null;
    liveCaptureRef.current = null;
    setLiveInk(null);
    const [a, b] = [...touchesRef.current.values()];
    const center = midpoint(a, b);
    const box = viewport.getBoundingClientRect();
    const view = viewRef.current;
    pinchRef.current = {
      distance: Math.max(distance(a, b), 1),
      scale: view.scale,
      content: {
        x: (center.x - box.left - view.x) / view.scale,
        y: (center.y - box.top - view.y) / view.scale,
      },
    };
    panRef.current = null;
  }, [capture, pointInImage, tool]);

  const onImagePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!touchesRef.current.has(event.pointerId)) return;
    touchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (pinch && touchesRef.current.size >= 2) {
      event.preventDefault();
      const [a, b] = [...touchesRef.current.values()];
      const center = midpoint(a, b);
      const viewport = viewportRef.current;
      if (!viewport) return;
      const box = viewport.getBoundingClientRect();
      const scale = clamp(pinch.scale * distance(a, b) / pinch.distance, MIN_ZOOM, MAX_ZOOM);
      applyView({
        scale,
        x: center.x - box.left - pinch.content.x * scale,
        y: center.y - box.top - pinch.content.y * scale,
      });
      return;
    }
    if (!capture && tool === "pen" && touchesRef.current.size === 1 && liveStrokeRef.current) {
      const next = pointInImage(event.clientX, event.clientY);
      if (next) {
        liveStrokeRef.current = [...liveStrokeRef.current, next];
        setLiveInk(liveStrokeRef.current);
      }
      return;
    }
    const pan = panRef.current;
    if (tool !== "hand" || !pan || pan.pointerId !== event.pointerId || touchesRef.current.size !== 1) return;
    const dx = event.clientX - pan.start.x;
    const dy = event.clientY - pan.start.y;
    if (!pan.moved && Math.hypot(dx, dy) <= 10) return;
    pan.moved = true;
    event.preventDefault();
    applyView({
      scale: pan.view.scale,
      x: pan.view.x + dx,
      y: pan.view.y + dy,
    });
  }, [applyView, capture, pointInImage, tool]);

  const onImagePointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    const wasPinching = pinchWasActiveRef.current;
    const liveStroke = liveStrokeRef.current;
    const liveSubject = liveCaptureRef.current;
    touchesRef.current.delete(event.pointerId);
    if (touchesRef.current.size < 2) pinchRef.current = null;
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    if (wasPinching) {
      if (touchesRef.current.size === 0) pinchWasActiveRef.current = false;
      return;
    }
    if (capture) return;

    if (tool === "hand" && pan?.pointerId === event.pointerId && !pan.moved) {
      const at = pointInImage(event.clientX, event.clientY);
      const video = videoRef.current;
      if (at && video) {
        void openCapturedMark(
          captureFrame(video),
          { kind: "point", point: at },
          null,
        );
      }
    } else if (tool === "pen" && liveStroke && liveSubject) {
      const mark = markFrom(liveStroke);
      void openCapturedMark(liveSubject, mark.pointer, mark.stroke);
    }
    liveStrokeRef.current = null;
    liveCaptureRef.current = null;
    setLiveInk(null);
  }, [capture, openCapturedMark, pointInImage, tool]);

  const selectTool = useCallback((next: TouchTool) => {
    touchesRef.current.clear();
    pinchRef.current = null;
    panRef.current = null;
    pinchWasActiveRef.current = false;
    liveStrokeRef.current = null;
    liveCaptureRef.current = null;
    setLiveInk(null);
    setTool(next);
  }, []);

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
    const viewport = viewportRef.current;
    if (!grabbed || !viewport) return;
    const box = viewport.getBoundingClientRect();
    writeBubble({
      left: event.clientX - box.left - grabbed.dx,
      top: event.clientY - box.top - grabbed.dy,
    });
  }, [writeBubble]);

  const onGrabEnd = useCallback(() => {
    grabbedAt.current = null;
  }, []);

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

  // The software keyboard takes the bottom half of the screen. Clamp the
  // unscaled bubble into the visual viewport without moving or scaling the
  // image beneath it.
  useEffect(() => {
    if (!pointer) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    function onResize() {
      if (document.activeElement instanceof HTMLInputElement) {
        const element = bubbleRef.current;
        if (!element) return;
        writeBubble({ left: element.offsetLeft, top: element.offsetTop });
      }
    }
    viewport.addEventListener("resize", onResize);
    return () => viewport.removeEventListener("resize", onResize);
  }, [pointer, writeBubble]);

  return (
    <main className="fixed inset-0 flex h-dvh flex-col overflow-hidden bg-black text-white">
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-1.5">
        <span className="flex min-h-11 min-w-0 items-center gap-2 text-xs text-white/60">
          <span className={`size-2 shrink-0 rounded-full ${connected ? "bg-green-400" : "bg-white/30"}`} aria-hidden />
          <span className="truncate">{connected ? t("live") : t("waitingShort")}</span>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <div role="group" aria-label={t("toolsLabel")} className="flex rounded-xl bg-white/10 p-1 shadow-sm">
            <button
              type="button"
              data-tool="hand"
              aria-label={t("handTool")}
              aria-pressed={tool === "hand"}
              title={t("handTool")}
              onClick={() => selectTool("hand")}
              className={`flex size-11 items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 ${tool === "hand" ? "bg-iris text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`}
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M7.5 11V6.5a1.5 1.5 0 0 1 3 0V10" /><path d="M10.5 10V5a1.5 1.5 0 0 1 3 0v5" /><path d="M13.5 10V6a1.5 1.5 0 0 1 3 0v5" /><path d="M16.5 11V8.5a1.5 1.5 0 0 1 3 0v5.25C19.5 18 16.25 21 12 21c-3 0-4.6-1.4-6.2-3.6l-2.1-2.9a1.6 1.6 0 0 1 2.5-2l1.3 1.25V11Z" />
              </svg>
            </button>
            <button
              type="button"
              data-tool="pen"
              aria-label={t("penTool")}
              aria-pressed={tool === "pen"}
              title={t("penTool")}
              onClick={() => selectTool("pen")}
              className={`flex size-11 items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 ${tool === "pen" ? "bg-iris text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`}
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m14.5 5.5 4 4" /><path d="m4 20 3.4-1 11.8-11.8a1.4 1.4 0 0 0 0-2l-.4-.4a1.4 1.4 0 0 0-2 0L5 16.6 4 20Z" /><path d="m13 8 4 4" />
              </svg>
            </button>
          </div>
          {capture ? (
            <button type="button" onClick={dismiss} className="min-h-11 rounded-full bg-white/15 px-3 text-sm text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70">
              {t("backToLive")}
            </button>
          ) : (
            <button type="button" onClick={stopWatching} aria-label={t("stopConnection")} title={t("stopConnection")} className="flex size-11 items-center justify-center rounded-full bg-white/10 text-white/60 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70">
              <span className="size-3.5 rounded-sm bg-current" aria-hidden />
            </button>
          )}
        </div>
      </header>

      <p className="shrink-0 px-4 pb-1 text-center text-pretty text-xs leading-snug text-white/45">
        {tool === "hand" ? t("handHint") : t("penHint")}
      </p>

      <div
        ref={viewportRef}
        data-companion-viewport=""
        data-active-tool={tool}
        className="relative min-h-0 flex-1 overflow-hidden overscroll-none"
        style={{ touchAction: "none" }}
        onPointerDown={onImagePointerDown}
        onPointerMove={onImagePointerMove}
        onPointerUp={onImagePointerEnd}
        onPointerCancel={onImagePointerEnd}
      >
        <div ref={wrapRef} data-companion-image-layer="" className="absolute left-0 top-0 origin-top-left overflow-hidden rounded-xl shadow-2xl ring-1 ring-white/10">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            onLoadedData={describeFirstFrame}
            onResize={() => {
              const video = videoRef.current;
              if (video?.videoWidth && video.videoHeight) setSourceAspect(video.videoWidth / video.videoHeight);
            }}
            className={`block h-full w-full object-contain ${capture ? "opacity-0" : ""}`}
          />
          {!capture && liveInk && <Stroke points={liveInk} />}
          {capture && (
            <div className="absolute inset-0">
              <Snapshot
                capture={capture}
                pointer={pointer}
                stroke={stroke}
                annotations={answer?.result.annotations ?? []}
                onPointer={point}
                thinking={busy}
                managedPinch
                interactionMode={tool === "hand" ? "tap" : "draw"}
              />
            </div>
          )}
        </div>

        {pointer !== null && (
          <div ref={bubbleRef} className="absolute z-30" style={{ left: 0, top: 0, visibility: "hidden" }}>
            <ExchangeBubble asked={asked} answer={answer} elapsedMs={elapsedMs} busy={busy} error={error} question={question} onQuestion={setQuestion} onSubmit={ask} onClose={close} grip={{ onGrab, onGrabMove, onGrabEnd }} />
          </div>
        )}
      </div>

      {pointer === null && (
        <div className="relative z-30 flex shrink-0 justify-center px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <ExchangeBubble asked={asked} answer={answer} elapsedMs={elapsedMs} busy={busy} error={error} question={question} onQuestion={setQuestion} onSubmit={ask} onClose={close} />
        </div>
      )}
    </main>
  );
}
