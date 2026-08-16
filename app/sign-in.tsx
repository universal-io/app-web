"use client";

import { useState } from "react";
import { supabaseBrowserClient } from "@/lib/supabase";

/**
 * M1 sign-in. This screen is the one thing standing between the product and
 * its own premise — open a link and go — and it stays until the Gateway grows
 * the anonymous guest flow (app-web/docs/requirements.md §5-D).
 */
export function SignIn() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function sendLink() {
    const address = email.trim();
    if (!address) return;
    setStatus("sending");
    setError(null);
    const { error: caught } = await supabaseBrowserClient().auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: window.location.origin },
    });
    if (caught) {
      setError(caught.message);
      setStatus("idle");
      return;
    }
    setStatus("sent");
  }

  return (
    <div className="mx-auto w-full max-w-sm space-y-4 py-16">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Universal I/O</h1>
        <p className="text-sm text-slate-500">
          いま見ている画面を、AIに見てもらえます。
        </p>
      </div>

      {status === "sent" ? (
        <p className="rounded-lg border border-slate-200 px-3 py-3 text-sm dark:border-slate-700">
          {email} にログイン用のリンクを送りました。メールを開いてください。
        </p>
      ) : (
        <div className="space-y-2">
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") sendLink();
            }}
            placeholder="メールアドレス"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800"
          />
          <button
            onClick={sendLink}
            disabled={status === "sending"}
            className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
          >
            {status === "sending" ? "送信中…" : "ログインリンクを送る"}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
