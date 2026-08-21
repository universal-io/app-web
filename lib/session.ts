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

/**
 * Where to send the browser back to after Google — and nothing else.
 *
 * Supabase matches `redirect_to` against its Redirect URLs allowlist as a
 * literal glob over the whole string. A query parameter on it — this used to
 * carry `?next=…` — makes the registered URL not match, and an unmatched
 * redirect is silently replaced with the project's Site URL. That is
 * api.universal-io.com, another client's landing page: the tokens arrived on
 * the wrong origin and this one stayed signed out, from every entry point at
 * once. So the URL is kept byte-identical to the registered value and the
 * destination travels beside it, in sessionStorage.
 */
function callbackURL(): string {
  return new URL("/auth/callback", window.location.origin).toString();
}

const NEXT_KEY = "universal-io:after-sign-in";

/**
 * The path to land on after the callback, stored by signInWithGoogle and
 * cleared on read. Only paths within this app pass: an open redirect would let
 * a link sign somebody in and then drop them on another site wearing this
 * one's trust. sessionStorage is per-tab, so two tabs signing in at once
 * cannot pick up each other's destination.
 */
export function consumeNext(): string {
  const next = window.sessionStorage.getItem(NEXT_KEY);
  window.sessionStorage.removeItem(NEXT_KEY);
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

/**
 * Whether a session stands for a person who signed in.
 *
 * Anonymous sign-in was removed, but the sessions it made did not disappear
 * with it: they live in the browser that got one and refresh themselves
 * indefinitely. Code that only asks "is there a session" therefore lets those
 * browsers straight past the sign-in — which is exactly what happened, and it
 * showed up as the product appearing to need no account at all. Identity is
 * decided here, in one place, so the wall, the token and the account display
 * cannot disagree about who is signed in.
 */
export function signedIn(session: Session | null): Session | null {
  if (!session) return null;
  return session.user.is_anonymous ? null : session;
}

export async function currentSession(): Promise<Session | null> {
  const { data } = await supabaseBrowserClient().auth.getSession();
  const session = signedIn(data.session ?? null);
  // A leftover anonymous session is not merely ignored but cleared, or it goes
  // on refreshing itself in the background for as long as the browser lives.
  if (data.session && !session) await signOut();
  return session;
}

export async function signInWithGoogle(next: string): Promise<void> {
  window.sessionStorage.setItem(NEXT_KEY, next);
  const { error } = await supabaseBrowserClient().auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callbackURL(),
      // Somebody with several accounts is otherwise silently signed in as
      // whichever one Google happens to prefer, which is the wrong one often
      // enough to be worth a click (app-mac asks for this too).
      queryParams: { prompt: "select_account" },
    },
  });
  if (error) throw new SessionError("sign-in-failed", `could not start the Google sign-in: ${error.message}`);
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
  if (!session) throw new SessionError("expired", "no session when a token was required");
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
  if (error) throw new SessionError("provision-failed", `could not provision the account: ${error.message}`);
  provisioned.add(session.user.id);
}

export class SessionError extends Error {
  /** Which failure this is, for the UI to translate (app/errors.ts). The
   * message stays developer-facing, for logs and stack traces. */
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

export type SessionErrorCode = "expired" | "sign-in-failed" | "provision-failed";
