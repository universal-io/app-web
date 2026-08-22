import { difference, type FrameSource } from "@/lib/screen-share";

/**
 * Is this page inside the picture it is showing?
 *
 * When somebody shares the screen or the window this page is on, the live view
 * can only ever show them themselves. That situation has exactly one right
 * answer — say so, and offer to pick again — and an answer that fixed means it
 * should not be left to a model to notice. It is a route, not a judgement.
 *
 * **Nothing passive can tell it.** The page cannot see itself, and every
 * property that looks decisive is not: frame size matches a maximised window
 * of any application, and "the picture keeps changing" is equally true of a
 * video. Asking the model is worse than it sounds — what a capture taken at
 * share start actually contains is a race between this page repainting and the
 * capture pipeline delivering, so it holds either the page before the share
 * began or a hall of mirrors, unpredictably, run to run.
 *
 * So the page asks a question instead of looking for a clue: **it changes its
 * own appearance and sees whether the picture changes with it.** If it does,
 * this page is in the picture. That is not an inference about content; it is a
 * measurement of whether one thing contains another.
 *
 * The change is a pulse of the wash — the veil that is over the picture during
 * the opening scan anyway — so what a person sees is the scan doing something,
 * not the page flashing at them.
 */

/**
 * Three frames, pulsed off / on / off, and the shape of the answer is in the
 * pattern rather than in any one number.
 *
 * A single "did it change?" cannot tell our pulse from a video playing on the
 * shared screen. Toggling twice can: what we did is distinctive in that the
 * middle frame stands apart from *both* of its neighbours while those two
 * resemble each other. Content that is simply moving drifts — every frame
 * differs from the last, and the first and last differ most of all, which is
 * the opposite shape.
 */
const FRAMES = 3;

/** Below this, the pulse did not register at all — no wash in the picture, so
 * the picture is not of this page. Well above frame-to-frame noise on a still
 * screen (measured at 0.000) and above the 0.03–0.04 an unfocused window
 * drifts by on its own (docs/capabilities.md §4-B). */
const REGISTERED = 0.06;

/** The pulse must stand out from the drift by this much. A shared video moves
 * the picture continuously, so its first and last frames are as different as
 * any neighbouring pair; ours returns to where it started. */
const OVER_DRIFT = 2.5;

/**
 * How long to let each state reach the capture.
 *
 * The page paints, the compositor composes, the capture pipeline delivers —
 * and on a monitor share that whole path runs once more for the copy of this
 * page inside the picture. Too short and the pulse is measured before it
 * arrives, which reads as "not a self share" — the failure that matters here,
 * because it is the silent one.
 */
const SETTLE_MS = 320;

export type SelfShareProbe = {
  /** Null when the probe could not run — a grab failed, or it was abandoned.
   * Null is not "no": nothing was measured, so nothing is claimed. */
  selfShare: boolean | null;
  /** The three differences, for `?debug` and for the log when this is wrong.
   * A judgement whose inputs cannot be read is one nobody can argue with. */
  readings: { pulse: number; release: number; drift: number } | null;
};

export async function probeSelfShare(input: {
  source: FrameSource;
  /** Turns the wash pulse on and off. The caller owns the appearance; this
   * file only owns the question being asked with it. */
  pulse: (on: boolean) => void;
  /** Abandoned when this returns true — the share ended, or the user asked
   * something and owns the page now. */
  cancelled: () => boolean;
  settleMs?: number;
}): Promise<SelfShareProbe> {
  const settle = input.settleMs ?? SETTLE_MS;
  const signatures: Uint8ClampedArray[] = [];

  try {
    for (let at = 0; at < FRAMES; at += 1) {
      input.pulse(at === 1);
      await new Promise((resolve) => setTimeout(resolve, settle));
      if (input.cancelled()) return { selfShare: null, readings: null };
      const frame = await input.source.grab();
      signatures.push(frame.signature);
    }
  } catch {
    // A grab that failed measured nothing. Saying "not a self share" here
    // would turn a missing reading into a claim.
    return { selfShare: null, readings: null };
  } finally {
    input.pulse(false);
  }

  const [before, during, after] = signatures;
  const readings = {
    pulse: difference(before, during),
    release: difference(during, after),
    drift: difference(before, after),
  };

  const registered = Math.min(readings.pulse, readings.release) >= REGISTERED;
  const returned = Math.min(readings.pulse, readings.release) >= readings.drift * OVER_DRIFT;
  return { selfShare: registered && returned, readings };
}
