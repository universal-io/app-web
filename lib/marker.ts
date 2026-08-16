"use client";

import type { Pointer } from "@/lib/gateway";
import type { Capture } from "@/lib/screen-share";

/**
 * Burns the user's gesture into the image before it is sent.
 *
 * Telling a model "the user tapped at x=0.42, y=0.31" asks it to map two
 * numbers onto a picture, which is the one thing these models are reliably bad
 * at — the first real run pointed at a button in the middle of the screen and
 * got back an explanation of the window's close button in the corner. The same
 * model draws accurate boxes when it chooses the target itself, so reading
 * coordinates off an image is not the problem; deriving a position from
 * arithmetic is.
 *
 * Drawing the mark turns that arithmetic into something the model can simply
 * see. It is the mirror image of the rule this product already follows in the
 * other direction — never make the model estimate coordinates it could be told.
 */

/** Magenta: effectively absent from real interface chrome, so the mark cannot
 * be mistaken for part of the screen underneath it. */
const MARK_COLOR = "#FF00E5";
const HALO_COLOR = "#FFFFFF";

export async function withPointerMark(
  capture: Capture,
  pointer: Pointer | null,
): Promise<string> {
  if (!pointer) return capture.base64;

  const image = await loadImage(capture.dataURL);
  const canvas = document.createElement("canvas");
  canvas.width = capture.width;
  canvas.height = capture.height;
  const context = canvas.getContext("2d");
  if (!context) return capture.base64;

  context.drawImage(image, 0, 0, capture.width, capture.height);

  // Scaled to the image rather than fixed in pixels, so the mark reads the same
  // on a phone-sized capture and a 1536px one.
  const unit = Math.max(capture.width, capture.height);
  const stroke = Math.max(2, unit * 0.004);

  context.lineJoin = "round";

  if (pointer.kind === "point") {
    const cx = pointer.point.x * capture.width;
    const cy = pointer.point.y * capture.height;
    const radius = unit * 0.022;
    // A ring, never a filled dot: whatever was pointed at has to stay visible,
    // or the mark hides the answer.
    ring(context, cx, cy, radius, stroke);
  } else {
    const { x, y, w, h } = pointer.region;
    rect(
      context,
      x * capture.width,
      y * capture.height,
      w * capture.width,
      h * capture.height,
      stroke,
    );
  }

  const dataURL = canvas.toDataURL("image/jpeg", 0.85);
  return dataURL.slice(dataURL.indexOf(",") + 1);
}

/** Every shape is drawn twice — a white halo under a magenta line — so it stays
 * visible on both a dark toolbar and a white document. */
function ring(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  stroke: number,
): void {
  for (const [color, width] of [[HALO_COLOR, stroke * 2.2], [MARK_COLOR, stroke]] as const) {
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.strokeStyle = color;
    context.lineWidth = width;
    context.stroke();
  }
  // A short crosshair through the centre, so the exact spot is unambiguous when
  // the ring happens to enclose several small controls.
  const tick = radius * 0.4;
  for (const [color, width] of [[HALO_COLOR, stroke * 2.2], [MARK_COLOR, stroke]] as const) {
    context.beginPath();
    context.moveTo(cx - tick, cy);
    context.lineTo(cx + tick, cy);
    context.moveTo(cx, cy - tick);
    context.lineTo(cx, cy + tick);
    context.strokeStyle = color;
    context.lineWidth = width;
    context.stroke();
  }
}

function rect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  stroke: number,
): void {
  for (const [color, width] of [[HALO_COLOR, stroke * 2.2], [MARK_COLOR, stroke]] as const) {
    context.strokeStyle = color;
    context.lineWidth = width;
    context.strokeRect(x, y, w, h);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("キャプチャを読み込めませんでした。"));
    image.src = src;
  });
}
