/**
 * Getting one frame of the user's screen, on demand.
 *
 * The prototype that proved this route streamed frames on a timer and paid for
 * it: a backgrounded tab has its timers throttled to exactly 1 fps, which made
 * a 15 fps setting silently deliver one frame a second (docs/inception.md §2).
 * Nothing here runs on a timer. The stream is held open and a frame is taken at
 * the moment a question is asked, so throttling has nothing to throttle.
 */

/** Longest edge of the capture sent to the Gateway. */
const MAX_EDGE = 1536;

/** JPEG rather than PNG: a screenshot of a UI is ~10x smaller as JPEG, and the
 * Gateway caps the request at 4MB of base64. Quality is high enough that small
 * Japanese text stays legible, which the prototype confirmed on real screens. */
const JPEG_QUALITY = 0.85;

export type CaptureError =
  | "unsupported"
  | "insecure-context"
  | "denied"
  | "no-video-track"
  | "capture-failed";

export class ScreenShareError extends Error {
  readonly kind: CaptureError;
  constructor(kind: CaptureError, message: string) {
    super(message);
    this.name = "ScreenShareError";
    this.kind = kind;
  }
}

export function screenShareUnavailableReason(): CaptureError | null {
  if (typeof navigator === "undefined") return null;
  // Order matters: on plain http over a LAN address the API is absent
  // entirely, and reporting that as "your browser cannot do this" sends people
  // to install a different browser for a problem that is the page's URL.
  if (!window.isSecureContext) return "insecure-context";
  if (!navigator.mediaDevices?.getDisplayMedia) return "unsupported";
  return null;
}

export function messageForCaptureError(kind: CaptureError): string {
  switch (kind) {
    case "insecure-context":
      return "画面共有には HTTPS が必要です（localhost は例外）。";
    case "unsupported":
      return "このブラウザでは画面共有を利用できません。パソコンの Chrome・Edge・Firefox・Safari をお使いください（iPhone・Android のブラウザは画面共有に対応していません）。";
    case "denied":
      return "画面の共有が許可されませんでした。";
    case "no-video-track":
      return "共有された映像を取得できませんでした。";
    case "capture-failed":
      return "画面を取得できませんでした。共有を停止していないかご確認ください。";
  }
}

export async function startScreenShare(): Promise<MediaStream> {
  const unavailable = screenShareUnavailableReason();
  if (unavailable) {
    throw new ScreenShareError(unavailable, messageForCaptureError(unavailable));
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
  } catch {
    // The spec reports a refused picker and a dismissed picker the same way,
    // and neither is an error worth alarming anyone about.
    throw new ScreenShareError("denied", messageForCaptureError("denied"));
  }
}

export type Capture = {
  /** Base64 without the data: prefix, which is what the Gateway wants. */
  base64: string;
  /** A data URL of the same bytes, for drawing on screen. */
  dataURL: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
};

/**
 * Takes the current frame from a live stream.
 *
 * The video element is a real, displayed element rather than a detached one:
 * a `display: none` video is not guaranteed to decode, which is how the
 * prototype ended up capturing blank frames (docs/inception.md §8).
 */
export async function captureFrame(video: HTMLVideoElement): Promise<Capture> {
  if (video.readyState < 2 || video.videoWidth === 0) {
    throw new ScreenShareError(
      "capture-failed",
      messageForCaptureError("capture-failed"),
    );
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new ScreenShareError(
      "capture-failed",
      messageForCaptureError("capture-failed"),
    );
  }
  context.drawImage(video, 0, 0, width, height);

  const dataURL = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const comma = dataURL.indexOf(",");
  return {
    base64: dataURL.slice(comma + 1),
    dataURL,
    mediaType: "image/jpeg",
    width,
    height,
  };
}
