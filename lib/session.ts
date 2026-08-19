"use client";

import type { Session } from "@supabase/supabase-js";
import { supabaseBrowserClient } from "@/lib/supabase";

/**
 * Signing in, and staying signed in.
 *
 * The Supabase project here is the same one app-mac uses, so a Google account
 * signed in on this page is literally the same `auth.users` row, the same
 * tenant and the same monthly allowance as on the desktop app. Nothing had to
 * be built for that; it follows from pointing at the same project, and it is
 * the reason this client must not invent an identity of its own.
 *
 * Every model call is metered and costs real money, so it is attributed to a
 * real account rather than to whoever happened to open the page.
 */

/** Where to send the browser back to after Google. */
function callbackURL(next: string): string {
  const url = new URL("/auth/callback", window.location.origin);
  if (next) url.searchParams.set("next", next);
  return url.toString();
}

export async function currentSession(): Promise<Session | null> {
  const { data } = await supabaseBrowserClient().auth.getSession();
  return data.session ?? null;
}

export async function signInWithGoogle(next: string): Promise<void> {
  const { error } = await supabaseBrowserClient().auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callbackURL(next),
      // Somebody with several accounts is otherwise silently signed in as
      // whichever one Google happens to prefer, which is the wrong one often
      // enough to be worth a click (app-mac asks for this too).
      queryParams: { prompt: "select_account" },
    },
  });
  if (error) throw new SessionError(`Googleのログインを開始できませんでした。（${error.message}）`);
}

export async function signOut(): Promise<void> {
  await supabaseBrowserClient().auth.signOut();
}

/**
 * A token that is still valid at the moment of the request.
 *
 * The session obtained when the page loaded is not good enough. Access tokens
 * expire in about an hour and this product is built to be left open all day —
 * a tab somebody opened when they got stuck at 10am and asked a question at
 * noon got "ログインが必要です" for a token that had quietly gone stale. The
 * client refreshes in the background, so asking it again costs nothing and
 * returns the current token rather than the one from page load.
 */
export async function accessToken(): Promise<string> {
  const session = await currentSession();
  if (!session) throw new SessionError("ログインの有効期限が切れました。もう一度サインインしてください。");
  return session.access_token;
}

/**
 * Give the account its tenant and entitlement.
 *
 * The Supabase project is shared with older work, so there is deliberately no
 * trigger on `auth.users` — every client calls this itself after signing in
 * (api-gateway/docs/supabase-setup.md). The Gateway would do it lazily on the
 * first request anyway, but doing it here means the account exists before the
 * user asks anything, and a failure is reported at sign-in where it can be
 * understood rather than as a failed question.
 */
const provisioned = new Set<string>();

export async function ensureProvisioned(session: Session): Promise<void> {
  if (provisioned.has(session.user.id)) return;
  const { error } = await supabaseBrowserClient().rpc("bs_initialize_current_user");
  if (error) throw new SessionError(`アカウントを準備できませんでした。（${error.message}）`);
  provisioned.add(session.user.id);
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}
