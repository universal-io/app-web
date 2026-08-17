import { difference, type Capture, type Frame, type FrameSource } from "@/lib/screen-share";

/**
 * The screens the user was just looking at.
 *
 * Share a whole monitor, then come back to this tab, and the live picture is of
 * this tab — the one screen nobody needs explained. Whatever they actually want
 * to ask about was on screen a moment *before* they returned, so the only way
 * to have it is to have kept it (docs/requirements-solo.md §3-1).
 *
 * Frames are taken only while the user is away, and that is what makes the
 * buffer honest rather than clever: every frame in it is, by construction, a
 * screen they were looking at. There is no hall of mirrors to detect and throw
 * out, because none is ever recorded.
 *
 * Nothing here is written anywhere. The buffer lives for as long as the share
 * does, and only the one frame the user picks and asks about is ever sent.
 */

/** One second. Background tabs are throttled to about this anyway, so asking
 * for more would be asking for a number the browser has already decided. */
const DEFAULT_INTERVAL_MS = 1000;

/** How many distinct screens to keep. Someone stuck on one thing has looked at
 * two or three; the rest of the room is there so that a page being scrolled
 * cannot evict the application they actually came back to ask about. */
const DEFAULT_MAX = 12;

/**
 * Below this difference, two frames are the same screen at two moments.
 *
 * Measured rather than guessed, on synthetic screens built to look like real
 * web applications (docs/requirements-solo.md §7):
 *
 *     0.000  the same screen, untouched
 *     0.024  a menu opened over it
 *     0.069  scrolled 50px
 *     0.174  scrolled 200px
 *     0.227  a different application, similar colouring
 *     0.370  dimmed behind a dialog
 *
 * The first guess of 0.045 sat below "scrolled 50px", so an ordinary scroll
 * started a new candidate and a long page could fill the buffer. This sits
 * above it and well below a different application, which is the separation
 * that matters — and it errs towards keeping two entries rather than merging
 * two applications, because a spare candidate is a thumbnail to skip while a
 * merged one is a screen that cannot be asked about at all.
 */
const SAME_SCREEN = 0.12;

export type RecentScreen = {
  /** Stable across in-place updates, so the strip does not reshuffle itself. */
  id: string;
  capture: Capture;
  signature: Uint8ClampedArray;
  /** When this screen was last seen, for ordering and for the debug panel. */
  at: number;
  /** How different this frame was from the entry it replaced, if it replaced
   * one. Only ever read by the debug panel. */
  drift: number | null;
};

/**
 * What the buffer did, reported alongside what it holds.
 *
 * Pushed out with every change rather than offered for polling: the two things
 * worth knowing — whether a background tab is still being fed frames, and how
 * often — are only observable while nobody is looking, so they have to be
 * recorded as they happen (docs/requirements-solo.md §7).
 */
export type RecentScreensReport = {
  /** Gaps between the last few grabs, newest first. Background throttling is
   * documented as one per second and observed to get worse. */
  intervals: number[];
  /** Whether frames are coming from the track rather than the video element. */
  viaTrack: boolean;
};

export type RecentScreensHandle = {
  stop(): void;
};

export function recordRecentScreens(options: {
  source: FrameSource;
  onChange: (screens: RecentScreen[], report: RecentScreensReport) => void;
  intervalMs?: number;
  max?: number;
}): RecentScreensHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const max = options.max ?? DEFAULT_MAX;

  let screens: RecentScreen[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let grabbing = false;
  let stopped = false;
  let lastGrabAt = 0;
  const gaps: number[] = [];

  /**
   * Away covers two different things that look the same from the shared
   * screen's point of view: another tab (hidden), and another application on
   * top of this one (visible but unfocused). Watching only `hidden` misses
   * everyone who works in windows side by side, which on a desktop is most
   * people.
   */
  function away(): boolean {
    return document.hidden || !document.hasFocus();
  }

  function absorb(frame: Frame, now: number): void {
    let nearest = -1;
    let smallest = Number.POSITIVE_INFINITY;
    screens.forEach((screen, index) => {
      const distance = difference(screen.signature, frame.signature);
      if (distance < smallest) {
        smallest = distance;
        nearest = index;
      }
    });

    if (nearest >= 0 && smallest < SAME_SCREEN) {
      // The same screen, a moment later. Keep one entry per screen, holding
      // its latest state, and move it to the front: the order people expect is
      // by when they last *looked* at something, which is exactly this.
      const existing = screens[nearest];
      screens = [
        { ...existing, capture: frame.capture, signature: frame.signature, at: now, drift: smallest },
        ...screens.filter((_, index) => index !== nearest),
      ];
    } else {
      screens = [
        { id: crypto.randomUUID(), capture: frame.capture, signature: frame.signature, at: now, drift: null },
        ...screens,
      ].slice(0, max);
    }
    report();
  }

  function report(): void {
    options.onChange(screens, { intervals: [...gaps], viaTrack: options.source.viaTrack });
  }

  async function tick(): Promise<void> {
    if (grabbing || stopped) return;
    grabbing = true;
    try {
      const frame = await options.source.grab();
      // A grab started while away can resolve after the user is back, and the
      // frame it resolves with may be of this page rather than of what they
      // left. Losing that one frame costs nothing — the previous tick holds
      // essentially the same screen — while keeping it would put the copilot
      // into the list of screens to ask the copilot about.
      if (stopped || !away()) return;
      const now = Date.now();
      if (lastGrabAt) gaps.unshift(now - lastGrabAt);
      if (gaps.length > 12) gaps.length = 12;
      lastGrabAt = now;
      absorb(frame, now);
    } catch {
      // One failed grab is not worth reporting: the next tick will try again,
      // and by definition nobody is here to read a message about it.
    } finally {
      grabbing = false;
    }
  }

  function sync(): void {
    if (stopped) return;
    if (away() && !timer) {
      // Deliberately no immediate grab. At the instant focus is lost the
      // desktop has not finished switching, so the frame available right now is
      // still this page — which would put a picture of the copilot into the
      // list of screens to ask the copilot about. Waiting one interval costs
      // nothing, because the user is still looking at whatever they turned to.
      timer = setInterval(() => void tick(), intervalMs);
    } else if (!away() && timer) {
      clearInterval(timer);
      timer = null;
      lastGrabAt = 0;
    }
  }

  document.addEventListener("visibilitychange", sync);
  window.addEventListener("blur", sync);
  window.addEventListener("focus", sync);
  sync();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("blur", sync);
      window.removeEventListener("focus", sync);
      screens = [];
      report();
    },
  };
}
