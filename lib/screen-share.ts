/**
 * Getting one frame of the user's screen, on demand.
 *
 * The prototype that proved this route streamed frames on a timer and paid for
 * it: a backgrounded tab has its timers throttled to exactly 1 fps, which made
 * a 15 fps setting silently deliver one frame a second (docs/inception.md §2).
 * Nothing here runs on a timer. The stream is held open and a frame is taken at
 * the moment a question is asked, so throttling has nothing to throttle.
 *
 * Solo mode does keep a slow buffer of frames while the tab is in the
 * background (lib/recent-screens.ts), which is the one place a timer appears —
 * but at a frame a second of *stills*, the throttle is a ceiling it never
 * reaches rather than a promise it silently breaks.
 */

/** Longest edge of the capture sent to the Gateway. */
const MAX_EDGE = 1536;

/** JPEG rather than PNG: a screenshot of a UI is ~10x smaller as JPEG, and the
 * Gateway caps the request at 4MB of base64. Quality is high enough that small
 * Japanese text stays legible, which the prototype confirmed on real screens. */
const JPEG_QUALITY = 0.85;

/**
 * Edge of the thumbnail used to tell two frames apart.
 *
 * Colour is kept rather than reduced to brightness. A greyscale version of this
 * merged a deep blue screen with a dark red one — different applications with
 * coincidentally similar luminance — and two mostly-white web apps are an even
 * easier way to hit that. Three channels of 16x16 is 768 bytes and one pass of
 * subtraction, which is nothing next to the JPEG encode it rides along with.
 */
const SIGNATURE_EDGE = 16;

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

/**
 * Which of the picker's three kinds of thing the user chose.
 *
 * Unknown means unknown, and the two modes fail very differently on a wrong
 * guess: treating a monitor share as a window share puts the live mirror on
 * screen and freezes a picture of this very page, while treating a window share
 * as a monitor share merely buffers frames it did not strictly need. So an
 * absent value — Firefox and Safari do not always report one — is read as
 * "monitor", the assumption whose failure is survivable.
 */
export type DisplaySurface = "monitor" | "window" | "browser";

export function surfaceOf(track: MediaStreamTrack): DisplaySurface {
  const reported = (track.getSettings() as { displaySurface?: string }).displaySurface;
  return reported === "window" || reported === "browser" ? reported : "monitor";
}

type ShareOptions = {
  /** Which pane of the picker to open on. A hint; browsers may ignore it. */
  prefer?: DisplaySurface;
};

export async function startScreenShare(options: ShareOptions = {}): Promise<MediaStream> {
  const unavailable = screenShareUnavailableReason();
  if (unavailable) {
    throw new ScreenShareError(unavailable, messageForCaptureError(unavailable));
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: options.prefer ? { displaySurface: options.prefer } : true,
      audio: false,
      // This tab is never worth sharing — to the phone it is the page holding
      // the QR code, and to solo mode it is the hall of mirrors. Removing it
      // from the picker is cheaper than explaining afterwards why the choice
      // did not work.
      selfBrowserSurface: "exclude",
      // Lets someone who shared one tab switch to another from the browser's
      // own bar, instead of stopping and going through the picker again.
      surfaceSwitching: "include",
    } as DisplayMediaStreamOptions);
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

export type Frame = {
  capture: Capture;
  /** RGB SIGNATURE_EDGE² thumbnail, for telling frames apart cheaply. */
  signature: Uint8ClampedArray;
};

/**
 * Takes the current frame from a live stream.
 *
 * The video element is a real, displayed element rather than a detached one:
 * a `display: none` video is not guaranteed to decode, which is how the
 * prototype ended up capturing blank frames (docs/inception.md §8).
 */
export async function captureFrame(video: HTMLVideoElement): Promise<Capture> {
  return frameFromVideo(video).capture;
}

function frameFromVideo(video: HTMLVideoElement): Frame {
  if (video.readyState < 2 || video.videoWidth === 0) {
    throw new ScreenShareError(
      "capture-failed",
      messageForCaptureError("capture-failed"),
    );
  }
  return encode(video, video.videoWidth, video.videoHeight);
}

function encode(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): Frame {
  const scale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);

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
  context.drawImage(source, 0, 0, width, height);

  const dataURL = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const comma = dataURL.indexOf(",");
  return {
    capture: {
      base64: dataURL.slice(comma + 1),
      dataURL,
      mediaType: "image/jpeg",
      width,
      height,
    },
    signature: signatureOf(canvas),
  };
}

function signatureOf(full: HTMLCanvasElement): Uint8ClampedArray {
  const pixels = SIGNATURE_EDGE * SIGNATURE_EDGE;
  const signature = new Uint8ClampedArray(pixels * 3);
  const canvas = document.createElement("canvas");
  canvas.width = SIGNATURE_EDGE;
  canvas.height = SIGNATURE_EDGE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return signature;
  context.drawImage(full, 0, 0, SIGNATURE_EDGE, SIGNATURE_EDGE);
  const { data } = context.getImageData(0, 0, SIGNATURE_EDGE, SIGNATURE_EDGE);
  for (let i = 0; i < pixels; i += 1) {
    signature[i * 3] = data[i * 4];
    signature[i * 3 + 1] = data[i * 4 + 1];
    signature[i * 3 + 2] = data[i * 4 + 2];
  }
  return signature;
}

/** Mean absolute difference of two signatures: 0 identical, 1 opposite. */
export function difference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / (a.length * 255);
}

/**
 * A way to take frames that does not depend on a video element being painted.
 *
 * Reading the `<video>` gives whatever it last decoded, which is the right
 * thing while somebody is looking at it. A backgrounded tab is another matter:
 * the browser is free to stop feeding a hidden video element, and the failure
 * mode is not an error but the same frame handed back forever — a buffer that
 * looks full and is worthless. `ImageCapture.grabFrame()` pulls from the track
 * instead, so nothing about this page's visibility applies to it.
 *
 * It is Chromium-only. Elsewhere the element is used and `viaTrack` says so,
 * which is what the debug panel reports rather than leaving a stale buffer to
 * be discovered by a wrong answer (docs/requirements-solo.md §7).
 */
export type FrameSource = {
  grab(): Promise<Frame>;
  /** Whether the most recent grab came from the track rather than the element. */
  readonly viaTrack: boolean;
  close(): void;
};

type ImageCapturer = { grabFrame(): Promise<ImageBitmap> };

export function createFrameSource(track: MediaStreamTrack, video: HTMLVideoElement): FrameSource {
  const Constructor = (window as unknown as {
    ImageCapture?: new (track: MediaStreamTrack) => ImageCapturer;
  }).ImageCapture;

  let capturer: ImageCapturer | null = null;
  try {
    capturer = Constructor ? new Constructor(track) : null;
  } catch {
    capturer = null;
  }

  const source = {
    viaTrack: false,
    async grab(): Promise<Frame> {
      if (capturer) {
        try {
          const bitmap = await capturer.grabFrame();
          try {
            source.viaTrack = true;
            return encode(bitmap, bitmap.width, bitmap.height);
          } finally {
            bitmap.close();
          }
        } catch {
          // A track that refuses grabFrame will keep refusing; stop paying for
          // the attempt and let the element carry it from here.
          capturer = null;
        }
      }
      source.viaTrack = false;
      return frameFromVideo(video);
    },
    close(): void {
      capturer = null;
    },
  };
  return source;
}
