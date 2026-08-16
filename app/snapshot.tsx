"use client";

import { useRef, useState } from "react";
import type { Annotation, Pointer } from "@/lib/gateway";
import type { Capture } from "@/lib/screen-share";

/**
 * The frozen screen, what the user pointed at, and what came back.
 *
 * Everything here lives in the image's normalized 0-1 space and is converted to
 * CSS percentages at the last moment. That is deliberate: the pointer sent to
 * the Gateway and the boxes drawn back over it go through the same conversion,
 * so a coordinate fault shows up as a visibly misplaced ring rather than as a
 * confident answer about the wrong thing (app-ios docs/lessons-from-app-mac.md).
 */

/** Below this, a drag was a click that wobbled rather than a ring. */
const DRAG_THRESHOLD = 0.02;

type Props = {
  capture: Capture;
  pointer: Pointer | null;
  annotations: Annotation[];
  onPointer: (pointer: Pointer | null) => void;
};

type DragState = { startX: number; startY: number; x: number; y: number };

export function Snapshot({ capture, pointer, annotations, onPointer }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  function positionOf(event: React.PointerEvent): { x: number; y: number } {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
    };
  }

  function onPointerDown(event: React.PointerEvent) {
    const { x, y } = positionOf(event);
    // Capturing the pointer keeps a ring being drawn from breaking when the
    // cursor leaves the image mid-drag.
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ startX: x, startY: y, x, y });
  }

  function onPointerMove(event: React.PointerEvent) {
    if (!drag) return;
    const { x, y } = positionOf(event);
    setDrag({ ...drag, x, y });
  }

  function onPointerUp() {
    if (!drag) return;
    const w = Math.abs(drag.x - drag.startX);
    const h = Math.abs(drag.y - drag.startY);
    if (w < DRAG_THRESHOLD || h < DRAG_THRESHOLD) {
      onPointer({ kind: "point", point: { x: drag.startX, y: drag.startY } });
    } else {
      onPointer({
        kind: "region",
        region: {
          x: Math.min(drag.startX, drag.x),
          y: Math.min(drag.startY, drag.y),
          w,
          h,
        },
      });
    }
    setDrag(null);
  }

  const live = drag && {
    x: Math.min(drag.startX, drag.x),
    y: Math.min(drag.startY, drag.y),
    w: Math.abs(drag.x - drag.startX),
    h: Math.abs(drag.y - drag.startY),
  };

  return (
    <section className="space-y-2">
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="relative touch-none select-none overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700"
        style={{ cursor: "crosshair" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={capture.dataURL} alt="共有された画面" className="block w-full" draggable={false} />

        {live && live.w > 0 && (
          <div className="pointer-events-none absolute border-2 border-blue-500 bg-blue-500/10" style={boxStyle(live)} />
        )}

        {!drag && pointer?.kind === "region" && (
          <div className="pointer-events-none absolute border-2 border-blue-500 bg-blue-500/10" style={boxStyle(pointer.region)} />
        )}

        {!drag && pointer?.kind === "point" && (
          <div
            className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-blue-500 bg-blue-500/20"
            style={{ left: `${pointer.point.x * 100}%`, top: `${pointer.point.y * 100}%` }}
          />
        )}

        {annotations.map((annotation) => (
          <div key={annotation.id} className="pointer-events-none absolute" style={boxStyle(annotation.box)}>
            <div className="h-full w-full rounded-sm border-2 border-amber-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.06)]" />
            {annotation.label && (
              // The label grows away from the nearer edge. Anchored always to
              // the left it runs off the screen for anything in the right-hand
              // column — which is where toolbars, close buttons and overflow
              // menus live, so it was most of what got labelled.
              <span
                className={`absolute whitespace-nowrap rounded bg-amber-400 px-1.5 py-0.5 text-xs font-medium text-slate-900 ${
                  labelSide(annotation.box) === "right" ? "right-0" : "left-0"
                } ${labelVertical(annotation.box) === "above" ? "bottom-full mb-1" : "top-full mt-1"}`}
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

/** Which edge of the box the label hangs from, so it opens inward. */
function labelSide(box: { x: number; w: number }): "left" | "right" {
  return box.x + box.w / 2 > 0.5 ? "right" : "left";
}

/** Near the bottom the label goes above the box for the same reason. */
function labelVertical(box: { y: number; h: number }): "above" | "below" {
  return box.y + box.h > 0.88 ? "above" : "below";
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
