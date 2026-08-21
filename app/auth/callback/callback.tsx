"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { supabaseBrowserClient } from "@/lib/supabase";
import { consumeNext, currentSession, ensureProvisioned } from "@/lib/session";
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
  const t = useTranslations("auth");
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
      // The destination was stored by signInWithGoogle, not carried on the
      // URL: a query parameter on redirect_to makes Supabase's allowlist not
      // match it (lib/session.ts).
      router.replace(consumeNext());
    }

    finish().catch((caught: unknown) => {
      if (cancelled) return;
      setError(caught instanceof Error ? caught.message : t("failedFinish"));
    });

    return () => {
      cancelled = true;
    };
  }, [params, router, t]);

  if (error) {
    return (
      <Shell>
        <Notice tone="error">{error}</Notice>
        <Link href="/" className="self-start rounded-[10px] border border-line px-3 py-2 text-sm text-body transition-colors hover:bg-paper">
          {t("startOver")}
        </Link>
      </Shell>
    );
  }
  return <Shell><p className="text-slate">{t("checking")}</p></Shell>;
}

