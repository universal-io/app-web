"use client";

import { useRef, useState } from "react";
import type { Annotation, Pointer } from "@/lib/gateway";
import type { Capture } from "@/lib/screen-share";

/**
 * The frozen screen, what the user drew on it, and what came back.
 *
 * The gesture model is app-ios's, not a new one: one finger, one stroke. Under
 * a threshold it is a tap meaning "this control"; over it, it is a ring meaning
 * "whatever is in here", which is how somebody asks about a group of things
 * they have no name for. The request carries the box around the stroke rather
 * than its outline — the model reasons about rectangles everywhere else in this
 * protocol, and a hand-drawn loop is a rectangle's worth of intent anyway —
 * while the drawn shape stays on screen, because that is what the person will
 * remember asking about (ios/UniversalIOCopilot/Views/MirrorView.swift).
 *
 * Everything lives in the image's normalized 0-1 space and becomes CSS
 * percentages at the last moment, so the mark sent and the boxes drawn back go
 * through one conversion. A coordinate fault then shows as a visibly misplaced
 * ring rather than a confident answer about the wrong thing.
 */

/** How far a finger travels before a tap becomes a ring. app-ios settled on
 * 24pt; as a fraction of the image it holds at any zoom. */
const RING_THRESHOLD = 0.03;

type Props = {
  capture: Capture;
  pointer: Pointer | null;
  annotations: Annotation[];
  onPointer: (pointer: Pointer | null, stroke: Point[] | null) => void;
  stroke: Point[] | null;
};

export type Point = { x: number; y: number };

export function Snapshot({ capture, pointer, annotations, onPointer, stroke }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState<Point[] | null>(null);

  function positionOf(event: React.PointerEvent): Point {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
    };
  }

  function onPointerDown(event: React.PointerEvent) {
    // Two fingers is the browser pinching to zoom, not somebody drawing.
    if (!event.isPrimary) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrawing([positionOf(event)]);
  }

  function onPointerMove(event: React.PointerEvent) {
    if (!drawing || !event.isPrimary) return;
    setDrawing([...drawing, positionOf(event)]);
  }

  function onPointerUp() {
    if (!drawing || drawing.length === 0) return;
    const mark = markFrom(drawing);
    onPointer(mark.pointer, mark.stroke);
    setDrawing(null);
  }

  const live = drawing ?? stroke;

  return (
    <section>
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrawing(null)}
        className="relative select-none overflow-hidden rounded-xl"
        style={{ touchAction: "pinch-zoom" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={capture.dataURL} alt="共有された画面" className="block w-full" draggable={false} />

        {/* The stroke as drawn, not the rectangle derived from it. */}
        {live && <Stroke points={live} />}

        {!drawing && pointer?.kind === "point" && (
          <div
            className="pointer-events-none absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-cyan"
            style={{ left: `${pointer.point.x * 100}%`, top: `${pointer.point.y * 100}%` }}
          />
        )}

        {annotations.map((annotation) => (
          <div key={annotation.id} className="pointer-events-none absolute" style={boxStyle(annotation.box)}>
            <div className="h-full w-full rounded-sm border-2 border-amber-400" />
            {annotation.label && (
              // The label grows away from the nearer edge. Anchored always to
              // the left it ran off the screen for anything in the right-hand
              // column — which is where toolbars, close buttons and overflow
              // menus live, so it was most of what ever got labelled.
              <span
                className={`absolute whitespace-nowrap rounded bg-amber-400 px-1.5 py-0.5 text-xs font-medium text-slate-900 ${
                  annotation.box.x + annotation.box.w / 2 > 0.5 ? "right-0" : "left-0"
                } ${annotation.box.y + annotation.box.h > 0.88 ? "bottom-full mb-1" : "top-full mt-1"}`}
              >
                {annotation.label}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * What a finished stroke means: one gesture, one intent.
 *
 * Shared with the live view, where the same stroke is drawn over moving video
 * rather than a still. Reading it in two places would be two chances for a tap
 * and a ring to start meaning different things depending on what was underneath.
 */
export function markFrom(points: Point[]): { pointer: Pointer; stroke: Point[] | null } {
  const box = boundsOf(points);
  return Math.max(box.w, box.h) < RING_THRESHOLD
    ? { pointer: { kind: "point", point: points[0] }, stroke: null }
    : { pointer: { kind: "region", region: box }, stroke: points };
}

/** The stroke as drawn, over whatever it was drawn on. */
export function Stroke({ points }: { points: Point[] }) {
  if (points.length < 2) return null;
  return (
    <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
      <polyline
        points={points.map((p) => `${p.x},${p.y}`).join(" ")}
        fill="none"
        stroke="#37d5f2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ strokeWidth: 3 }}
      />
    </svg>
  );
}

export function boundsOf(points: Point[]): { x: number; y: number; w: number; h: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function boxStyle(box: { x: number; y: number; w: number; h: number }): React.CSSProperties {
  return {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
  };
}

function clamp(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
