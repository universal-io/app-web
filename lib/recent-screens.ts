import { difference, type Capture, type Frame, type FrameSource } from "@/lib/screen-share";

/**
 * The screens the user was just looking at.
 *
 * Share a whole monitor, then come back to this tab, and the live picture is of
 * this tab — the one screen nobody needs explained. Whatever they actually want
 * to ask about was on screen a moment *before* they returned, so the only way
 * to have it is to have kept it (docs/solo-mode.md §4).
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
 * web applications (docs/solo-mode.md §7):
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
 *
 * Exported because the same line decides, on returning to this tab, whether
 * the live picture already shows what the newest candidate holds — one
 * measured threshold, used for one meaning, in both places (app/page.tsx).
 */
export const SAME_SCREEN = 0.12;

/**
 * How long after turning away the calibration frame is allowed to speak for.
 *
 * Long enough to cover a desktop switching applications, short enough that a
 * calibration frame taken too late — one that caught the destination rather
 * than the departure — cannot suppress more than a couple of frames of it.
 */
const SETTLING_MS = 2_500;

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
 * recorded as they happen (docs/solo-mode.md §7).
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
  /** What the share showed at the moment the user turned away — this page, on
   * a share that contains it. Anything still matching it is not a screen they
   * went to look at. Cleared on every return, because the next departure
   * leaves from somewhere else. */
  let leaving: Uint8ClampedArray | null = null;
  let leftAt = 0;
  const gaps: number[] = [];

  /**
   * Away is losing focus, not only being hidden — and getting this wrong cost
   * the feature its whole point.
   *
   * `hidden` is true when this tab is not the frontmost tab of its window, or
   * the window is minimised. **It is not true when another application comes
   * to the front**, which is exactly, and almost only, how somebody goes to
   * look at the screen they want explained. Narrowed to `hidden` alone, the
   * recorder therefore never ran on real hardware: the user went to another
   * app, came back, and was offered nothing — while the synthetic check, which
   * fakes `hidden` directly, stayed green through every session.
   *
   * It was narrowed for a real reason. Chrome's own "sharing your screen" bar
   * is a separate window that takes focus the moment sharing begins, so with
   * focus as the signal, recording started instantly with this page in full
   * view and filled the buffer with a hall of mirrors before the user had gone
   * anywhere (log.md). That is a startup problem, and it is answered where it
   * happens: the recorder is not started until the opening look has finished
   * (app/page.tsx), which is well past the moment the bar grabs focus.
   *
   * What remains is the side-by-side case: this page is still visible while
   * the user works in another application. The frame then shows that
   * application in front with this page beside or behind it — which is a fair
   * picture of what they were looking at, not a mirror. A frame that is purely
   * this page only happens when this page is frontmost, and then it has focus
   * and nothing is recorded at all.
   */
  /**
   * Has the user's attention been on this page at any point in this share?
   *
   * Until it has, "unfocused" does not mean they went anywhere. Sharing hands
   * focus to Chrome's own "sharing your screen" bar — a separate window this
   * page cannot take it back from — so from the moment a share begins until
   * the moment the user first clicks in, `hasFocus()` is false while the user
   * is sitting right here looking at the page. Recording through that records
   * the page: the offer appeared before anyone had gone anywhere, saying
   * "直前に見ていたページです" about a picture of itself.
   *
   * The latch belongs to the recorder, so it belongs to the share: a new share
   * starts closed however long the page was focused before it.
   */
  let heldFocus = false;

  function away(): boolean {
    if (document.hidden) return true;
    if (!heldFocus) return false;
    return !document.hasFocus();
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
      // The same, one beat earlier: the desktop takes a few hundred
      // milliseconds to finish switching, so the first frame after focus goes
      // can still be this page. Held rather than absorbed, it becomes the one
      // thing every later frame is checked against — if the picture has not
      // moved off this page yet, there is nothing to keep. This is the frame
      // the recorder used to throw away on purpose; kept, it does more work
      // than discarding it ever did.
      if (!leaving) {
        leaving = frame.signature;
        leftAt = Date.now();
        return;
      }
      // Only while the desktop is still settling. The calibration frame is
      // taken on trust — that the grab resolves before the switch completes —
      // and trust needs a bound: if it resolved late, it holds a picture of
      // the screen the user actually went to, and an unbounded filter would
      // then silently discard every frame of the one thing worth keeping. A
      // few seconds cannot be wrong for long. Past that, whatever the share
      // shows is what they turned to, and the worst case is one extra
      // thumbnail rather than an empty offer.
      if (Date.now() - leftAt < SETTLING_MS && difference(leaving, frame.signature) < SAME_SCREEN) return;
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
    if (!document.hidden && document.hasFocus()) heldFocus = true;
    if (away() && !timer) {
      // The first tick is the calibration one (see `leaving`), so it is worth
      // taking promptly rather than a whole interval later — until it lands
      // there is nothing to tell this page's own picture apart from a screen
      // worth keeping.
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
    } else if (!away() && timer) {
      clearInterval(timer);
      timer = null;
      lastGrabAt = 0;
      leaving = null;
      leftAt = 0;
    }
  }

  // Read once at the start as well as on every event: a share that begins
  // with this page focused (the picker did not hand focus away) must not wait
  // for a focus event that already happened.
  sync();

  document.addEventListener("visibilitychange", sync);
  window.addEventListener("blur", sync);
  window.addEventListener("focus", sync);

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
