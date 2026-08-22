"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
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
 *
 * One colour runs through all of it: iris, the same purple as the buttons.
 * Pointing at something, circling it, and the boxes that come back are three
 * halves of one sentence — the user says "this" and the answer says "this" —
 * so they are painted alike. A second hue would have to mean a second thing,
 * and there is no second thing. Amber survives only where it means caution
 * (uncertainties, warnings), which is a different sentence entirely.
 *
 * The wash and spotlight are deliberately NOT this colour (app/wash.ts): a
 * translucent sheet over arbitrary screens was tuned by measuring what it does
 * to dark and light pages, and matching it to a solid accent would undo that.
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
  /** Whether the answer is still being read. The mark pulses either way — the
   * first proof that the tap was heard has to be at the place that was tapped
   * — and while waiting it simply beats quicker. */
  thinking?: boolean;
  /** The parent owns two-finger zoom/pan. One finger remains this component's
   * pointing gesture, while a second finger cancels the pending mark. */
  managedPinch?: boolean;
  /** Draw accepts a one-finger stroke. Tap leaves one-finger movement to a
   * parent canvas and emits only a stationary tap as a point. */
  interactionMode?: "draw" | "tap";
};

export type Point = { x: number; y: number };

export function Snapshot({
  capture,
  pointer,
  annotations,
  onPointer,
  stroke,
  thinking = false,
  managedPinch = false,
  interactionMode = "draw",
}: Props) {
  const t = useTranslations("app");
  const containerRef = useRef<HTMLDivElement>(null);
  const activePointers = useRef(new Set<number>());
  const pinching = useRef(false);
  const tapStart = useRef<Point | null>(null);
  const tapMoved = useRef(false);
  const [drawing, setDrawing] = useState<Point[] | null>(null);

  function positionOf(event: React.PointerEvent): Point {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
    };
  }

  function onPointerDown(event: React.PointerEvent) {
    if (managedPinch) {
      activePointers.current.add(event.pointerId);
      if (activePointers.current.size > 1) {
        pinching.current = true;
        setDrawing(null);
        return;
      }
    }
    // Two fingers are zooming, not drawing.
    if (!event.isPrimary) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    tapStart.current = { x: event.clientX, y: event.clientY };
    tapMoved.current = false;
    setDrawing([positionOf(event)]);
  }

  function onPointerMove(event: React.PointerEvent) {
    if (pinching.current || !drawing || !event.isPrimary) return;
    if (interactionMode === "tap") {
      const start = tapStart.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
        tapMoved.current = true;
      }
      return;
    }
    setDrawing([...drawing, positionOf(event)]);
  }

  function onPointerUp(event: React.PointerEvent) {
    if (managedPinch) activePointers.current.delete(event.pointerId);
    if (pinching.current) {
      setDrawing(null);
      if (activePointers.current.size === 0) pinching.current = false;
      return;
    }
    if (!drawing || drawing.length === 0) return;
    if (interactionMode === "tap") {
      if (!tapMoved.current) {
        onPointer({ kind: "point", point: drawing[0] }, null);
      }
      tapStart.current = null;
      tapMoved.current = false;
      setDrawing(null);
      return;
    }
    const mark = markFrom(drawing);
    onPointer(mark.pointer, mark.stroke);
    setDrawing(null);
  }

  function onPointerCancel(event: React.PointerEvent) {
    if (managedPinch) activePointers.current.delete(event.pointerId);
    if (activePointers.current.size === 0) pinching.current = false;
    tapStart.current = null;
    tapMoved.current = false;
    setDrawing(null);
  }

  const live = interactionMode === "draw" ? drawing ?? stroke : stroke;

  return (
    <section>
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        className="relative select-none overflow-hidden rounded-xl"
        style={{ touchAction: managedPinch ? "none" : "pinch-zoom" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={capture.dataURL} alt={t("sharedScreenAlt")} className="block w-full" draggable={false} />

        {/* The stroke as drawn, not the rectangle derived from it. */}
        {live && <Stroke points={live} />}

        {!drawing && pointer?.kind === "point" && (
          <div
            data-pin=""
            className="io-mark pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: `${pointer.point.x * 100}%`,
              top: `${pointer.point.y * 100}%`,
              width: "calc(2.25rem * var(--io-overlay-scale, 1))",
              height: "calc(2.25rem * var(--io-overlay-scale, 1))",
              boxShadow: "inset 0 0 0 calc(2px * var(--io-overlay-scale, 1)) var(--color-iris)",
            }}
          >
            {/* The halo carries the pulse rather than the ring itself, so the
                thing the eye measures the position by never moves. */}
            <span
              className={`io-pin-pulse absolute rounded-full ${
                thinking ? "io-pin-pulse-fast" : ""
              }`}
              style={{
                inset: "calc(-1px * var(--io-overlay-scale, 1))",
                boxShadow: "inset 0 0 0 calc(2px * var(--io-overlay-scale, 1)) var(--color-iris)",
              }}
            />
          </div>
        )}

        {annotations.map((annotation) => (
          <div key={annotation.id} className="pointer-events-none absolute" style={boxStyle(annotation.box)}>
            <div
              data-box=""
              className="io-mark h-full w-full"
              style={{
                borderRadius: "calc(2px * var(--io-overlay-scale, 1))",
                boxShadow: "inset 0 0 0 calc(2px * var(--io-overlay-scale, 1)) var(--color-iris)",
              }}
            />
            {annotation.label && (
              // The label grows away from the nearer edge. Anchored always to
              // the left it ran off the screen for anything in the right-hand
              // column — which is where toolbars, close buttons and overflow
              // menus live, so it was most of what ever got labelled.
              <span
                className={`absolute whitespace-nowrap rounded bg-iris px-1.5 py-0.5 text-xs font-medium text-white ${
                  annotation.box.x + annotation.box.w / 2 > 0.5 ? "right-0" : "left-0"
                } ${annotation.box.y + annotation.box.h > 0.88 ? "bottom-full" : "top-full"}`}
                style={{
                  marginTop: annotation.box.y + annotation.box.h > 0.88
                    ? undefined
                    : "calc(4px * var(--io-overlay-scale, 1))",
                  marginBottom: annotation.box.y + annotation.box.h > 0.88
                    ? "calc(4px * var(--io-overlay-scale, 1))"
                    : undefined,
                  transform: "scale(var(--io-overlay-scale, 1))",
                  transformOrigin: `${annotation.box.x + annotation.box.w / 2 > 0.5 ? "right" : "left"} ${annotation.box.y + annotation.box.h > 0.88 ? "bottom" : "top"}`,
                }}
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
    <svg
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      className="io-mark pointer-events-none absolute inset-0 h-full w-full"
    >
      <polyline
        points={points.map((p) => `${p.x},${p.y}`).join(" ")}
        fill="none"
        stroke="var(--color-iris)"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ strokeWidth: "calc(3px * var(--io-overlay-scale, 1))" }}
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
