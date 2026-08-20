"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { normalizeRoomId } from "@/lib/room";

/**
 * How the watching device gets into a room.
 *
 * Scanning the QR is the fast path, but it cannot be the only one. iOS opens a
 * link from the camera in Safari, never in an installed Home Screen app — so
 * for the device this is built to be installed on, a scan lands somewhere other
 * than the app the person just launched. Typing the code always works.
 */
export function Join({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function go() {
    const code = normalizeRoomId(value);
    if (!code) {
      setError("8文字のコードを入力してください。");
      return;
    }
    router.push(`/companion/${code}`);
  }

  return (
    <section className={compact ? "space-y-2" : "space-y-3"}>
      {!compact && (
        <div className="space-y-1">
          <h2 className="text-base font-medium">共有された画面を見る</h2>
          <p className="text-sm text-slate">
            パソコン側に表示されているコードを入力してください。
          </p>
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") go();
          }}
          placeholder="コード（例 K3M9-P2XQ）"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-[10px] border border-edge bg-white px-3 py-3 font-mono text-base tracking-widest text-ink outline-none transition-colors focus:border-iris"
        />
        <button
          onClick={go}
          className="shrink-0 rounded-[10px] bg-ink px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-iris"
        >
          見る
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
