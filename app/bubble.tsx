"use client";

import { motion, useReducedMotion } from "motion/react";
import { useTranslations } from "next-intl";
import type { VisionSuccess } from "@/lib/gateway";
import { Notice } from "@/app/ui";

/**
 * The exchange, beside the thing it is about.
 *
 * The front-page demo answers next to whatever the cursor rests on, and this
 * is the real version of that bubble: the same dark card, the same question
 * chip, the same order — but the words come from the Gateway, not a script
 * (docs/pointing.md). The look is deliberately identical to app/demo.tsx so
 * that the mock a visitor saw is the product they get; only the "デモ" badge
 * is absent, because this one is not pretending.
 *
 * One bubble, one subject. Pointing somewhere else moves it; it never
 * multiplies and never accumulates a transcript. The turns still stack up
 * underneath for the model's benefit — the bubble just doesn't wear them.
 *
 * The typing-in performance the demo does is not reproduced here. The demo
 * types to show that answering takes an act; the real thing has an actual wait
 * to show, and padding it with theatre would be lying about the latency in the
 * other direction.
 */

export function ExchangeBubble({
  asked,
  answer,
  elapsedMs,
  busy,
  error,
  question,
  onQuestion,
  onSubmit,
  onClose,
  grip,
}: {
  /** The typed question this exchange is about; null when they only pointed. */
  asked: string | null;
  answer: VisionSuccess | null;
  /** Wall-clock ms from send to answer, measured where the user waited. */
  elapsedMs: number | null;
  busy: boolean;
  error: string | null;
  question: string;
  onQuestion: (value: string) => void;
  onSubmit: () => void;
  onClose: (() => void) | null;
  /** Supplied by callers that let the bubble be dragged. The grip appears only
   * when they are, so a surface without a pointer never shows one. */
  grip?: {
    onGrab: (event: React.PointerEvent) => void;
    onGrabMove: (event: React.PointerEvent) => void;
    onGrabEnd: (event: React.PointerEvent) => void;
  };
}) {
  const t = useTranslations("ask");
  const reduce = useReducedMotion();
  // Nothing said, nothing pending: the bubble is only its input box. This is
  // the resting state of the bottom-docked bubble; the anchored one always has
  // at least a wait to show.
  const empty = !busy && !answer && !error && !asked;

  // A bar of its own for the two controls. Floated into the prose, the close
  // button pushed the first line of the answer around it and read as part of
  // the sentence; a bar keeps the text a rectangle and gives the grip a place
  // to live that is nowhere near anything you would want to click.
  const closable = Boolean(onClose) && !empty;
  const bar = Boolean(grip) || closable;

  return (
    <div
      data-bubble
      className="w-[min(21rem,calc(100vw-2rem))] rounded-2xl bg-carbon/95 text-white shadow-2xl backdrop-blur"
    >
      {bar && (
        <div className="flex items-center justify-between px-2 pt-1.5">
          {grip ? (
            // No label. A grip that has to say it is a grip is not one — and
            // the product's whole claim is that pointing beats reading.
            <span
              onPointerDown={grip.onGrab}
              onPointerMove={grip.onGrabMove}
              onPointerUp={grip.onGrabEnd}
              onPointerCancel={grip.onGrabEnd}
              className="cursor-grab rounded p-1 text-white/25 transition-colors hover:text-white/50 active:cursor-grabbing"
              style={{ touchAction: "none" }}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                <circle cx="9" cy="7" r="1.4" /><circle cx="15" cy="7" r="1.4" />
                <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
                <circle cx="9" cy="17" r="1.4" /><circle cx="15" cy="17" r="1.4" />
              </svg>
            </span>
          ) : (
            <span />
          )}
          {closable && (
            <button
              onClick={onClose ?? undefined}
              aria-label={t("close")}
              className="rounded-full p-1.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      )}

      <div className={`space-y-2 px-3.5 pb-3.5 ${bar ? "pt-1" : "pt-3.5"}`}>
      {asked && (
        <div className="flex justify-end">
          <span className="max-w-[85%] rounded-xl rounded-br-sm bg-iris px-2.5 py-1.5 text-[12px] leading-snug text-white">
            {asked}
          </span>
        </div>
      )}

      {busy && <Reading label={t("reading")} reduce={reduce === true} />}

      {!busy && error && <Notice tone="error">{error}</Notice>}

      {!busy && answer && (
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="space-y-2"
        >
          <div className="max-h-[40vh] space-y-2 overflow-y-auto">
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-white/90">
              {answer.result.message}
            </p>
            {answer.result.uncertainties.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-[12px] text-amber-300">
                {answer.result.uncertainties.map((item) => <li key={item}>{item}</li>)}
              </ul>
            )}
            {answer.meta.notices?.map((notice) => (
              <Notice key={notice.code} tone="warn">{notice.message}</Notice>
            ))}
          </div>
          {/* Injected knowledge is always named: knowledge you cannot see is
              knowledge you can neither question nor correct. */}
          <div className="flex flex-wrap gap-1.5 text-[11px] text-white/50">
            {answer.result.skill && (
              <span className="rounded-full bg-white/10 px-2 py-0.5">
                {t("usedSkill", { name: answer.result.skill.name })}
              </span>
            )}
            {elapsedMs !== null && (
              <span className="rounded-full bg-white/10 px-2 py-0.5">
                {t("seconds", { value: (elapsedMs / 1000).toFixed(1) })}
              </span>
            )}
          </div>
        </motion.div>
      )}

      <QuestionInput value={question} onChange={onQuestion} onSubmit={onSubmit} busy={busy} />
      </div>
    </div>
  );
}

/**
 * The wait, shown as a wait. Between the click and the answer there are whole
 * seconds of model time, and a bubble that just sits there reads as a bubble
 * that didn't hear. The dots are the only animation: they claim "working", not
 * "almost done", because we don't know when it lands (app-mac R11: nothing
 * ends in silence — and nothing waits in silence either).
 */
function Reading({ label, reduce }: { label: string; reduce: boolean }) {
  return (
    <div className="flex items-center gap-2.5 text-[13px] leading-relaxed text-white/70">
      {!reduce && (
        <span className="flex gap-1" aria-hidden>
          {[0, 1, 2].map((at) => (
            <span
              key={at}
              className="io-think-dot h-1.5 w-1.5 rounded-full bg-cyan"
              style={{ animationDelay: `${at * 0.16}s` }}
            />
          ))}
        </span>
      )}
      {label}
    </div>
  );
}

export function QuestionInput({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const t = useTranslations("ask");
  return (
    <div className="flex gap-2">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Committing kana with Enter must not send the half-typed question.
          if (event.key === "Enter" && !event.nativeEvent.isComposing) onSubmit();
        }}
        aria-label={t("placeholder")}
        className="min-w-0 flex-1 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-base text-white"
      />
      <button
        // Called with no arguments on purpose. Handing `onSubmit` straight to
        // onClick passes a click event as its first parameter, and a caller
        // whose handler takes an optional argument silently receives it —
        // which is how the ask path came to be given a MouseEvent in place of
        // the picture to ask about. TypeScript cannot see it: `() => void` is
        // assignable to an event handler.
        onClick={() => onSubmit()}
        disabled={busy}
        className="shrink-0 rounded-[10px] bg-iris px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-iris-deep disabled:opacity-40"
      >
        {busy ? t("sending") : t("send")}
      </button>
    </div>
  );
}

export type Rect = { left: number; top: number; width: number; height: number };

/**
 * Where the bubble goes: beside the pointed-at thing, never on it.
 *
 * The same rule as the demo's place() — a fixed gap, flipped away from the
 * edges — extended for the things the demo doesn't have: the target can be a
 * drawn ring's whole rectangle rather than a cursor point, and the answer's
 * own annotation boxes are somewhere the bubble shouldn't sit either
 * (docs/pointing.md §2.2, §2.4). Sides are tried in order; the first one that
 * stays on screen and off the target wins, with the annotation-avoiding side
 * preferred among those. When nothing is clean, on-screen beats clean.
 */
export function placeBeside(
  target: Rect,
  size: { w: number; h: number },
  avoid: Rect[],
  view: { w: number; h: number },
  prefer: "beside" | "above" = "beside",
): { left: number; top: number } {
  const pad = 20;
  const margin = 12;
  // A thumb covers what it touches, so the touch layout leads with "above,
  // clear of the finger" instead of the cursor's "beside" (§4).
  const lift = 44;
  const candidates =
    prefer === "above"
      ? [
          { left: target.left + target.width / 2 - size.w / 2, top: target.top - lift - size.h },
          { left: target.left + target.width / 2 - size.w / 2, top: target.top + target.height + lift },
          { left: target.left + target.width + pad, top: target.top },
          { left: target.left - pad - size.w, top: target.top },
        ]
      : [
          { left: target.left + target.width + pad, top: target.top },
          { left: target.left - pad - size.w, top: target.top },
          { left: target.left, top: target.top + target.height + pad },
          { left: target.left, top: target.top - pad - size.h },
        ];

  const clamp = (at: { left: number; top: number }) => ({
    left: Math.min(Math.max(at.left, margin), Math.max(margin, view.w - size.w - margin)),
    top: Math.min(Math.max(at.top, margin), Math.max(margin, view.h - size.h - margin)),
  });
  const overlaps = (at: { left: number; top: number }, rect: Rect) =>
    at.left < rect.left + rect.width + 8 &&
    at.left + size.w > rect.left - 8 &&
    at.top < rect.top + rect.height + 8 &&
    at.top + size.h > rect.top - 8;

  const placed = candidates.map(clamp);
  const offTarget = placed.filter((at) => !overlaps(at, target));
  const clean = offTarget.find((at) => !avoid.some((rect) => overlaps(at, rect)));
  return clean ?? offTarget[0] ?? placed[0];
}

/** Puts the bubble where it belongs, held inside the window. Written straight
 * to the node: placement is a DOM measurement answered with a DOM position,
 * and routing it through state would re-render the page on every drag frame. */
export function write(element: HTMLElement, at: { left: number; top: number }) {
  const margin = 8;
  const left = Math.min(Math.max(at.left, margin), Math.max(margin, window.innerWidth - element.offsetWidth - margin));
  const top = Math.min(Math.max(at.top, margin), Math.max(margin, window.innerHeight - element.offsetHeight - margin));
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.visibility = "visible";
}
