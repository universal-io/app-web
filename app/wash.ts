import type { CSSProperties } from "react";

/**
 * The wash and the spotlight, shared between the front-page demo and the real
 * mirror. The two must not drift apart: the demo's promise is that what it
 * shows is what the product does, so the veil over the marketing page and the
 * veil over a shared screen are one construction (README「デザインは製品サイトを
 * 正本とする」 and docs/pointing.md §2.3).
 *
 * What the layers are:
 *
 * - A backdrop dim, relative to whatever is underneath. A translucent colour
 *   alone inverted over dark pages — blue over near-black *lightens* it — so
 *   the darkening has to be a filter, not a paint.
 * - An iris tint with a faint dot lattice over it. The lattice is the "this is
 *   a sensor looking at the surface" cue, kept just above the threshold of
 *   notice: it should be found, not seen.
 * - A radial mask that cuts the whole overlay away under the cursor. The core
 *   is held fully clear, and the falloff then runs long and eased — a steep
 *   rim reads as a hole punched in a card, a long one as light.
 * - A band that travels down the picture while the system takes its first
 *   look. This is the one layer the demo does not use, because the demo has no
 *   such moment — there is no share for it to read. Everything else here is
 *   shared and must stay that way.
 */

/**
 * Eased falloff: fully clear to half the reach, then a ramp to opaque over the
 * remaining half. Enough stops that it doesn't band on large soft edges.
 *
 * The halfway split is what makes it read as a light rather than as haze. An
 * earlier version held only a quarter clear and spent the other three on the
 * ramp, which spread the colour so evenly from centre to edge that there was
 * no edge to see. A wide untouched core, then a firmer shoulder, gives the
 * spot a shape — while the outer radius stays where it was, so the wash still
 * arrives gently at its far side.
 */
const FALLOFF =
  "transparent 0%, transparent 50%," +
  " rgba(0,0,0,0.10) 58%, rgba(0,0,0,0.30) 66%, rgba(0,0,0,0.55) 74%," +
  " rgba(0,0,0,0.78) 82%, rgba(0,0,0,0.93) 91%," +
  " #000 100%";

/**
 * The hole the spotlight cuts in the wash. `reach` is where the falloff ends,
 * not where clarity ends: the held-clear core is 50% of it, and every stop of
 * the ramp is a fraction of it too. So this one number resizes the whole
 * light — clear centre and shade together, in proportion.
 */
export function spotMask(reach: number): string {
  return `radial-gradient(circle ${reach}px at var(--x, 50%) var(--y, 50%), ${FALLOFF})`;
}

/**
 * The opening scan, laid over the wash while the first look is in flight.
 *
 * The wash says "this is a picture to point at". For the couple of seconds
 * before anything has been asked, something also has to say "and it is being
 * read, right now, all of it" — otherwise the share opens on a veiled picture
 * that appears to be waiting for the user when it is the user who is waiting.
 *
 * A band rather than a spinner, and travelling over the whole picture rather
 * than sitting in a corner, because what is being examined is the whole
 * picture. It is the same iris as the wash and only a little brighter: this is
 * the quietest of the layers, and it has to stay legible over a light screen
 * and a dark one without touching either one's own lightness (the rule the
 * whole file exists to protect).
 */
/**
 * The pulse the page asks its question with (lib/self-share.ts).
 *
 * Laid over the scan for a third of a second, twice interrupted: if this page
 * is inside the picture it is showing, the picture goes through it too, and
 * that is the whole measurement. It has to be large and flat — a small or
 * subtle change cannot be told from a video playing on the shared screen —
 * which is why it is a full-bleed iris rather than a moving detail.
 *
 * It reads as the scan doing something, because during the opening scan a
 * veil over the picture is already what is on screen. Nothing about it is
 * decorative: take it away and the page has no way to know whether it is
 * looking at itself.
 */
export const PULSE_STYLE: CSSProperties = {
  background: "rgba(74,80,255,0.34)",
};

export const SCAN_STYLE: CSSProperties = {
  background:
    "linear-gradient(to bottom," +
    " rgba(74,80,255,0) 0%, rgba(120,126,255,0.16) 42%," +
    " rgba(160,166,255,0.30) 50%, rgba(120,126,255,0.16) 58%," +
    " rgba(74,80,255,0) 100%)",
  backgroundSize: "100% 44%",
  backgroundRepeat: "no-repeat",
};

/**
 * Everything about the wash except the mask, which page focus may withhold.
 *
 * **The purple must never come from a heavier flat tint.** A flat colour laid
 * over the picture drags dark pages and light pages alike toward its own
 * lightness, so a wash at 0.32 alpha compresses the difference between them by
 * a third — a dark app stops looking dark and a light one stops looking light,
 * which is the exact inversion solo-mode.md warns about. It happened here:
 * "raise the purple's saturation" was once answered by doubling the alpha, and
 * the shared screen lost its own light and shade.
 *
 * So the vividness is bought where it costs nothing: `saturate()` on the
 * backdrop makes the screen's own colours (and the thin tint over them) read
 * as more purple without touching relative lightness, and `contrast()` pays
 * back exactly what the remaining tint flattens. The tint itself stays thin
 * and gets its colour from chroma, not from quantity.
 */
export const WASH_STYLE: CSSProperties = {
  // Nothing is filtered: the veil is the tint and the lattice, and only those.
  // The picture keeps its own light and shade exactly — the strongest form of
  // the rule this file exists to protect. What it costs is on light screens:
  // white reads 255 in the cleared core and about 227 under a 0.20 tint, so
  // the spot is told apart by hue far more than by brightness. On dark screens
  // the tint is lighter than the surface, so the spot is the darker region
  // instead. The wash marks the picture either way — by colour, not by shadow.
  background:
    // The lattice, then the tint under it. White dots at 0.16 on a 22px grid:
    // quiet enough to be found rather than seen, loud enough to survive the
    // tint that sits under them.
    "radial-gradient(circle, rgba(255,255,255,0.16) 1px, transparent 1.5px) 0 0 / 22px 22px," +
    " linear-gradient(rgba(74,80,255,0.40), rgba(74,80,255,0.40))",
};
