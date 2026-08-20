"use client";

import type { VisionSuccess } from "@/lib/gateway";
import { Notice } from "@/app/ui";

/**
 * The two pieces every asking surface needs: what came back, and the box to
 * type the next question into.
 *
 * Both modes — the second device watching a mirror, and one machine looking at
 * its own recent screens — ask the same question about the same kind of still
 * image and get the same shape of answer back. Sharing the panel keeps the one
 * rule that must not drift between them: the injected knowledge is named on
 * screen, every time.
 */

export function AnswerPanel({ answer }: { answer: VisionSuccess }) {
  const { result, meta } = answer;
  return (
    <div className="max-h-48 space-y-2 overflow-y-auto rounded-xl bg-white/10 p-3 text-white">
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{result.message}</p>

      {result.uncertainties.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-300">
          {result.uncertainties.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}

      {meta.notices?.map((notice) => (
        <Notice key={notice.code} tone="warn">{notice.message}</Notice>
      ))}

      {/* Injected knowledge is always named: knowledge you cannot see is
          knowledge you can neither question nor correct. */}
      <div className="flex flex-wrap gap-2 text-xs text-white/60">
        {result.skill && <span className="rounded-full bg-white/10 px-2 py-1">使った知識: {result.skill.name}</span>}
        {typeof meta.latency_ms === "number" && (
          <span className="rounded-full bg-white/10 px-2 py-1">{(meta.latency_ms / 1000).toFixed(1)}秒</span>
        )}
      </div>
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
  return (
    <div className="flex gap-2">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Committing kana with Enter must not send the half-typed question.
          if (event.key === "Enter" && !event.nativeEvent.isComposing) onSubmit();
        }}
        placeholder="質問（指すだけでも聞けます）"
        className="min-w-0 flex-1 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-base text-white placeholder:text-white/40"
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
        {busy ? "…" : "聞く"}
      </button>
    </div>
  );
}
