"use client";

import type { Session } from "@supabase/supabase-js";
import { supabaseBrowserClient } from "@/lib/supabase";

/**
 * A session, without ever asking for one.
 *
 * The Gateway requires a Supabase bearer token on every AI route, and that is
 * not a formality to route around: it is what meters usage and what keeps the
 * model providers' keys on the server. But "authenticated" does not have to
 * mean "signed in". An anonymous sign-in produces a real session with a real
 * user id and no interaction at all, which is the only way the product's
 * premise — open a link and go — survives contact with a metered backend.
 *
 * Anonymous users are provisioned exactly like any other: bs_provision_user
 * gives them a personal tenant on the free plan. Narrowing that to a smaller
 * guest allowance is an anti-abuse measure for a public URL, not a prerequisite
 * for the product working (docs/two-device-mode.md §5).
 */
export async function ensureSession(): Promise<Session> {
  const supabase = supabaseBrowserClient();

  const { data: existing } = await supabase.auth.getSession();
  if (existing.session) return existing.session;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) {
    // The overwhelmingly likely cause is a project setting rather than a bug,
    // and a message that says which switch to flip is worth more than the
    // library's generic text.
    throw new SessionError(
      "ゲストとして開始できませんでした。Supabase の Authentication → Sign In / Providers で"
      + "「Anonymous sign-ins」が有効になっているか確認してください。"
      + `（詳細: ${error.message}）`,
    );
  }
  if (!data.session) {
    throw new SessionError("ゲストセッションを作成できませんでした。");
  }
  return data.session;
}

/**
 * A token that is still valid at the moment of the request.
 *
 * The session obtained when the page loaded is not good enough. Access tokens
 * expire in about an hour and this product is built to be left open all day —
 * a tab somebody opened when they got stuck at 10am and asked a question at
 * noon got "ログインが必要です" for a product that has no login. The client
 * refreshes in the background, so asking it again costs nothing and returns the
 * current token rather than the one from page load.
 */
export async function accessToken(): Promise<string> {
  const supabase = supabaseBrowserClient();
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.access_token;
  // Storage cleared, or signed out in another tab. A guest session is free to
  // create, so recreate it rather than telling the user to do something about
  // an account they never made.
  return (await ensureSession()).access_token;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}
