"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabaseBrowserClient } from "@/lib/supabase";
import { currentSession, ensureProvisioned, signedIn, signInWithGoogle, signOut, SessionError } from "@/lib/session";
import { Notice, Shell } from "@/app/ui";

/**
 * Who is signed in, kept current for the life of the page.
 *
 * Subscribed rather than read once: the token is refreshed in the background
 * and can also be revoked from another tab, and a page holding a session
 * object from load time would go on showing a signed-in interface for an
 * account that is no longer there.
 */
export function useAccount(): { ready: boolean; session: Session | null; error: string | null } {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    currentSession()
      .then((next) => {
        if (cancelled) return;
        setSession(next);
        setReady(true);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "ログイン状態を確認できませんでした。");
        setReady(true);
      });

    const { data } = supabaseBrowserClient().auth.onAuthStateChange((_event, next) => {
      // The same judgement as currentSession(): a leftover anonymous session
      // arriving by this path must not become "signed in" either.
      setSession(signedIn(next));
    });
    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, []);

  return { ready, session, error };
}

/**
 * The sign-in wall.
 *
 * Every question costs a model call, so it is charged to an account rather
 * than to whoever opened the page. The account is the same one the desktop app
 * uses — the two share a Supabase project — so signing in here is not a second
 * registration, and saying so is worth the line it takes.
 */
export function SignIn({ next, reason }: { next: string; reason?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle(next);
    } catch (caught) {
      setError(caught instanceof SessionError ? caught.message : "ログインを開始できませんでした。");
      setBusy(false);
    }
  }, [next]);

  return (
    <Shell>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Universal I/O</h1>
        <p className="text-sm text-slate">
          画面を見せて、分からないところを聞けるコパイロットです。
        </p>
      </header>

      {reason && <Notice tone="warn">{reason}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <button
        onClick={start}
        disabled={busy}
        className="flex w-full max-w-sm items-center justify-center gap-3 self-start rounded-[10px] border border-line bg-white px-4 py-3 text-base font-medium text-ink shadow-sm transition-colors hover:bg-paper disabled:opacity-50"
      >
        <svg viewBox="0 0 18 18" className="h-5 w-5" aria-hidden>
          <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
          <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
          <path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.02-2.33Z" />
          <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.02 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
        </svg>
        {busy ? "Googleに移動しています…" : "Googleでサインイン"}
      </button>

      <p className="max-w-lg rounded-lg bg-paper px-3 py-3 text-xs leading-relaxed text-body">
        Mac版アプリと同じアカウントです。どちらでサインインしても、同じ利用枠と履歴になります。
        画面の画像と回答は保存されません。
      </p>
    </Shell>
  );
}

/**
 * Everything behind the wall.
 *
 * Provisioning is done here rather than only in the callback, because a
 * session can also arrive from another tab or from storage, and the account
 * has to exist before the first question either way.
 */
export function RequireAccount({
  next,
  children,
}: {
  next: string;
  children: (session: Session) => React.ReactNode;
}) {
  const { ready, session, error } = useAccount();
  const [provisionError, setProvisionError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    ensureProvisioned(session).catch((caught: unknown) => {
      if (cancelled) return;
      setProvisionError(caught instanceof Error ? caught.message : "アカウントを準備できませんでした。");
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!ready) return <Shell><p className="text-slate">読み込み中…</p></Shell>;
  if (error) {
    return (
      <Shell>
        <Notice tone="error">{error}</Notice>
      </Shell>
    );
  }
  if (!session) return <SignIn next={next} />;
  if (provisionError) {
    return (
      <Shell>
        <Notice tone="error">{provisionError}</Notice>
      </Shell>
    );
  }
  return <>{children(session)}</>;
}

/**
 * Which account this is, and the way out of it.
 *
 * Small and at the bottom: it is not what anybody came for, but a signed-in
 * product that will not say who you are, on a machine that may be shared, is
 * asking to be distrusted.
 */
export function Account() {
  const { session } = useAccount();
  const [busy, setBusy] = useState(false);
  if (!session) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line pt-6 text-xs text-slate">
      <span>{session.user.email ?? "サインイン済み"}</span>
      <button
        onClick={() => {
          setBusy(true);
          void signOut();
        }}
        disabled={busy}
        className="underline disabled:opacity-50"
      >
        ログアウト
      </button>
      <span className="text-faint">Mac版と同じアカウントです</span>
    </div>
  );
}
