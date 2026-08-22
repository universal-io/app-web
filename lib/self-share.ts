import { type FrameSource } from "@/lib/screen-share";

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
 * Three frames, pulsed off / on / off, and the answer is in the shape rather
 * than in any one size.
 *
 * A single "did it change?" cannot tell our pulse from a video playing on the
 * shared screen. Toggling twice can: what we did is distinctive in that the
 * middle frame stands apart from *both* of its neighbours while those two
 * resemble each other. Content that is merely moving drifts — every frame
 * differs from the last, and the first and last differ most of all, which is
 * the opposite shape.
 */
const FRAMES = 3;

/**
 * The test is per square of the picture, not over the whole of it.
 *
 * Averaged across the frame, this measured how *much* of the shared screen
 * this page fills — which on a real monitor is a fraction, so a real self
 * share would read weaker than the synthetic one it was tuned against and slip
 * under any threshold worth setting. Asked square by square, the question
 * stops depending on size: a browser window covering a tenth of a monitor
 * still turns that tenth of the squares iris and back.
 *
 * It also stops depending on what else is going on. A video playing elsewhere
 * on the shared screen moves its own squares, but they do not move *with us*
 * and back, so they are not counted — where a whole-frame number would have
 * been dragged around by them.
 */

/** How far one square must move, on 0-1, to have followed the pulse. The wash
 * pulse is a flat iris over everything this page draws, so a square showing
 * any of it moves far; frame-to-frame noise on a still screen measures 0.000
 * and an unfocused window drifts by 0.03–0.04 (docs/capabilities.md §4-B). */
const FOLLOWED = 0.08;

/** A square that followed must also come back. Its first and last readings are
 * both pulse-off, so they should agree — this is the half that a video, which
 * simply keeps going, can never satisfy. */
const RETURNED = 3;

/** How many squares of the 16x16 must follow before this is called a self
 * share. Low, because a browser window is allowed to be small on a big
 * monitor; not one, because one square is a coincidence. */
const ENOUGH = 6;

const EDGE = 16;

/**
 * How long to let each state reach the capture.
 *
 * The page paints, the compositor composes, the capture pipeline delivers —
 * and on a share containing this page that whole path runs once more for the
 * copy inside the picture. Too short and the pulse is measured before it
 * arrives, which reads as "not a self share": the silent failure, and so the
 * one to spend milliseconds against.
 */
const SETTLE_MS = 320;

export type SelfShareProbe = {
  /** Null when the probe could not run — a grab failed, or it was abandoned.
   * Null is not "no": nothing was measured, so nothing is claimed. */
  selfShare: boolean | null;
  /** How many of the 16x16 squares followed the pulse and came back, and how
   * far the strongest of them moved. For `?debug`, and for the log on the day
   * this is wrong: a judgement whose inputs cannot be read is one nobody can
   * argue with. */
  readings: { followed: number; strongest: number } | null;
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
  let followed = 0;
  let strongest = 0;
  for (let cell = 0; cell < EDGE * EDGE; cell += 1) {
    const pulse = cellDifference(before, during, cell);
    const release = cellDifference(during, after, cell);
    const drift = cellDifference(before, after, cell);
    const moved = Math.min(pulse, release);
    if (moved < FOLLOWED) continue;
    // Went with us and came back. A square that merely kept changing has
    // drifted as far as it moved, and is not counted.
    if (drift * RETURNED > moved) continue;
    followed += 1;
    strongest = Math.max(strongest, moved);
  }

  return { selfShare: followed >= ENOUGH, readings: { followed, strongest } };
}

/** How far one square of the picture moved between two frames, on 0-1. */
function cellDifference(a: Uint8ClampedArray, b: Uint8ClampedArray, cell: number): number {
  const at = cell * 3;
  return (
    (Math.abs(a[at] - b[at]) + Math.abs(a[at + 1] - b[at + 1]) + Math.abs(a[at + 2] - b[at + 2])) /
    (3 * 255)
  );
}
