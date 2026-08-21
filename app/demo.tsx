"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import { spotMask, WASH_STYLE } from "@/app/wash";

/**
 * The front page answering its own question.
 *
 * The headline asks "どこが分からない？", and this layer is the reply: move the
 * pointer and the page dims behind a spotlight — the same wash-and-spot the
 * real mirror uses (app/page.tsx) — and whatever the cursor is over explains
 * itself in a small three-panel exchange: what it is, what you might ask, what
 * comes back. The product's claim is that nothing needs explaining in advance,
 * so the front page demonstrates instead of describing.
 *
 * Every word is scripted (messages/*.json, `demo`). Nothing here calls a
 * model: the page has to work before sign-in and cost nothing, which a real
 * call cannot. The family rule is that invisible knowledge cannot be
 * questioned or corrected — so the bubble wears a small "デモ" badge rather
 * than passing the script off as an answer.
 *
 * The real UI now answers the same way — a bubble beside the pointed-at
 * place, docs/pointing.md — and shares this layer's wash (app/wash.ts). What
 * stays demo-only is answering on mere hover: the product answers on a click,
 * because a real model call costs money per pass (pointing.md §6).
 *
 * Only pointers that can hover get any of this. On touch there is no
 * rollover to speak, and the wash would just sit dark over the page.
 */

const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

function useCanHover(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(HOVER_QUERY);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(HOVER_QUERY).matches,
    () => false,
  );
}

/** The mirror's spotlight, smaller here: the targets on this page are single
 * elements rather than a whole shared screen (app/wash.ts). */
const SPOT_MASK = spotMask(504);

/** How the exchange advances: the explanation types, the question pops in
 * whole (people don't watch themselves type), the answer types, and then it
 * stays. `hold` is the end of the story, not a pause in it. */
type Beat = "explain" | "question" | "answer" | "hold";

export function ExplainDemo() {
  const t = useTranslations("demo");
  const reduce = useReducedMotion();
  // Hover-capable pointers only. Subscribed the same way ui.tsx answers "is
  // this the browser yet": false on the server and first paint, the real
  // answer after — so SSR renders none of this and hydration agrees.
  const enabled = useCanHover();
  /** The wash appears with the first movement, so the page loads clean and
   * turns into the demo the moment the visitor does anything. */
  const [awake, setAwake] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const washRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) return;

    function place(x: number, y: number) {
      const wash = washRef.current;
      if (wash) {
        wash.style.setProperty("--x", `${x}px`);
        wash.style.setProperty("--y", `${y}px`);
      }
      const bubble = bubbleRef.current;
      if (bubble) {
        // Beside the cursor, flipped at the edges so it never runs off screen.
        const pad = 20;
        const w = bubble.offsetWidth;
        const h = bubble.offsetHeight;
        let left = x + pad;
        if (left + w > window.innerWidth - 12) left = x - w - pad;
        let top = y + pad;
        if (top + h > window.innerHeight - 12) top = y - h - pad;
        bubble.style.transform = `translate(${Math.max(12, left)}px, ${Math.max(12, top)}px)`;
      }
    }

    function onMove(event: PointerEvent) {
      setAwake(true);
      place(event.clientX, event.clientY);
      // The overlay is pointer-events-none, so the event's target is the real
      // page under it — the element the person is actually pointing at.
      const hit = (event.target as Element).closest?.("[data-demo]") ?? null;
      setTarget(hit ? hit.getAttribute("data-demo") : null);
    }
    function onLeave() {
      setAwake(false);
      setTarget(null);
    }
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <>
      {/* The wash. Same construction as the mirror's: a backdrop dim (relative
          to whatever is underneath) under an iris tint, with the spot cut out
          of the whole overlay so the pointed-at thing is left untouched. */}
      <div
        ref={washRef}
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[60] transition-opacity duration-500"
        style={{
          ...WASH_STYLE,
          opacity: awake ? 1 : 0,
          maskImage: SPOT_MASK,
          WebkitMaskImage: SPOT_MASK,
        }}
      />
      {/* The bubble rides the cursor; its transform is written directly on
          pointermove, so following the mouse never re-renders anything. */}
      <div
        ref={bubbleRef}
        className="pointer-events-none fixed left-0 top-0 z-[70]"
        style={{ willChange: "transform" }}
      >
        <AnimatePresence mode="wait">
          {awake && (
            <motion.div
              key={target ?? "blank"}
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
            >
              {target ? (
                <Exchange id={target} reduce={reduce === true} />
              ) : (
                <div className="w-[240px] rounded-xl bg-carbon/90 px-3.5 py-3 text-[12px] leading-relaxed text-white/70 shadow-2xl backdrop-blur">
                  <Badge label={t("badge")} />
                  {t("blank")}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

function Badge({ label }: { label: string }) {
  return (
    <span className="float-right ml-2 rounded-full border border-white/20 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-white/50">
      {label}
    </span>
  );
}

/**
 * One target's three panels, walked on a loop for as long as the pointer
 * stays: explanation types in, the question lands whole, the answer types in,
 * everything holds to be read, and the exchange starts over. Keyed by target
 * from the caller, so moving to another element starts its script clean.
 */
function Exchange({ id, reduce }: { id: string; reduce: boolean }) {
  const t = useTranslations("demo");
  const explain = t(`targets.${id}.e`);
  const question = t(`targets.${id}.q`);
  const answer = t(`targets.${id}.a`);

  // Reduced motion starts — and stays — at the whole exchange at rest: the
  // most informative state, without the performance. Fresh state per target
  // is the caller's key on this component.
  const [beat, setBeat] = useState<Beat>(reduce ? "hold" : "explain");
  const [typedE, setTypedE] = useState(reduce ? explain.length : 0);
  const [typedA, setTypedA] = useState(reduce ? answer.length : 0);

  /**
   * Played once, then left alone.
   *
   * Not a loop. A cursor resting on something is not asking to be told the
   * same thing again, and a panel that restarts under a still pointer reads as
   * a stuck animation rather than as an answer. So the exchange runs to its
   * end and stops there, complete and readable for as long as the pointer
   * stays.
   *
   * Replaying is the caller's business, not this effect's: the bubble is keyed
   * by target, so pointing at something else — or leaving and coming back —
   * mounts a fresh copy and starts it over. One hover, one telling.
   */
  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    (async () => {
      for (let i = 1; i <= explain.length; i++) {
        if (cancelled) return;
        setTypedE(i);
        await sleep(18);
      }
      await sleep(650);
      if (cancelled) return;

      setBeat("question");
      await sleep(700);
      if (cancelled) return;

      setBeat("answer");
      for (let i = 1; i <= answer.length; i++) {
        if (cancelled) return;
        setTypedA(i);
        await sleep(16);
      }
      if (cancelled) return;

      setBeat("hold");
    })();
    return () => {
      cancelled = true;
    };
  }, [id, reduce, explain, answer]);

  const showQuestion = beat === "question" || beat === "answer" || beat === "hold";
  const showAnswer = beat === "answer" || beat === "hold";

  return (
    <div className="w-[300px] space-y-2 rounded-2xl bg-carbon/95 p-3.5 text-white shadow-2xl backdrop-blur">
      <div className="text-[13px] leading-relaxed text-white/90">
        <Badge label={t("badge")} />
        {id === "choose" && <ChooseFigure />}
        {explain.slice(0, typedE)}
        {beat === "explain" && <Caret />}
      </div>
      {showQuestion && (
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="flex justify-end"
        >
          <span className="max-w-[85%] rounded-xl rounded-br-sm bg-iris px-2.5 py-1.5 text-[12px] leading-snug text-white">
            {question}
          </span>
        </motion.div>
      )}
      {showAnswer && (
        <div className="text-[13px] leading-relaxed text-white/90">
          {answer.slice(0, typedA)}
          {beat === "answer" && <Caret />}
        </div>
      )}
    </div>
  );
}

function Caret() {
  return (
    <span
      aria-hidden
      className="ml-[1px] inline-block h-[13px] w-[2px] translate-y-[2px] animate-pulse bg-cyan"
    />
  );
}

/**
 * The one illustrated bubble. "画面を選ぶ" is the button everything else
 * exists to get pressed, so its explanation carries a small picture of what
 * happens next: a screen chosen, a spot pointed at, a bubble answering.
 */
function ChooseFigure() {
  return (
    <svg
      viewBox="0 0 264 96"
      className="mb-2.5 block w-full rounded-lg bg-white/[0.06]"
      aria-hidden
    >
      {/* the chosen screen */}
      <rect x="14" y="12" width="128" height="72" rx="5" fill="none" stroke="#9ba3b5" strokeWidth="1.5" />
      <rect x="14" y="12" width="128" height="12" rx="5" fill="#9ba3b5" opacity="0.35" />
      <circle cx="21" cy="18" r="1.6" fill="#2a2c33" />
      <circle cx="27" cy="18" r="1.6" fill="#2a2c33" />
      <rect x="24" y="34" width="70" height="5" rx="2.5" fill="#9ba3b5" opacity="0.5" />
      <rect x="24" y="45" width="96" height="5" rx="2.5" fill="#9ba3b5" opacity="0.3" />
      <rect x="24" y="56" width="52" height="5" rx="2.5" fill="#9ba3b5" opacity="0.3" />
      {/* the pointed-at control, lit */}
      <rect x="98" y="62" width="34" height="13" rx="3" fill="none" stroke="#37d5f2" strokeWidth="1.5" />
      <circle cx="115" cy="68" r="11" fill="none" stroke="#37d5f2" strokeWidth="1" opacity="0.45" />
      {/* the cursor */}
      <path d="M113 66l7 17 2.4-6.6 6.6-2.4z" fill="#ffffff" stroke="#101114" strokeWidth="1" />
      {/* the answer bubble */}
      <rect x="158" y="24" width="92" height="48" rx="8" fill="#5b5cff" />
      <rect x="167" y="35" width="66" height="5" rx="2.5" fill="#ffffff" opacity="0.9" />
      <rect x="167" y="46" width="74" height="5" rx="2.5" fill="#ffffff" opacity="0.65" />
      <rect x="167" y="57" width="46" height="5" rx="2.5" fill="#ffffff" opacity="0.65" />
      <path d="M158 56l-9 6 9 3z" fill="#5b5cff" />
    </svg>
  );
}
