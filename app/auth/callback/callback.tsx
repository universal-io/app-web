"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { supabaseBrowserClient } from "@/lib/supabase";
import { currentSession, ensureProvisioned } from "@/lib/session";
import { Notice, Shell } from "@/app/ui";

/**
 * Finishing the sign-in.
 *
 * Two things have to happen before the user is sent on, and both can fail in
 * ways worth naming: the authorization code has to be exchanged for a session,
 * and the account has to be given its tenant (`bs_initialize_current_user` —
 * this Supabase project deliberately has no trigger on `auth.users`, because
 * it is shared with other work). Landing on a working page with neither done
 * would only move the failure to the first question asked.
 */
export function AuthCallback() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function finish() {
      const supabase = supabaseBrowserClient();
      // Google reports a refusal here rather than by failing the exchange.
      const denied = params.get("error_description") ?? params.get("error");
      if (denied) throw new Error(`Googleのログインが完了しませんでした。（${denied}）`);

      const code = params.get("code");
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) throw exchangeError;
      }

      const session = await currentSession();
      if (!session) throw new Error("ログイン情報を受け取れませんでした。もう一度お試しください。");

      await ensureProvisioned(session);
      if (cancelled) return;
      router.replace(safeNext(params.get("next")));
    }

    finish().catch((caught: unknown) => {
      if (cancelled) return;
      setError(caught instanceof Error ? caught.message : "ログインを完了できませんでした。");
    });

    return () => {
      cancelled = true;
    };
  }, [params, router]);

  if (error) {
    return (
      <Shell>
        <Notice tone="error">{error}</Notice>
        <Link href="/" className="self-start rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600">
          最初からやり直す
        </Link>
      </Shell>
    );
  }
  return <Shell><p className="text-slate-500">ログインを確認しています…</p></Shell>;
}

/** An open redirect would let a link sign somebody in and then drop them on
 * another site wearing this one's trust, so only paths within this app pass. */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/solo";
  return next;
}
