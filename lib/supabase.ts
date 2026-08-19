"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The browser's Supabase session, which is the only credential this client
 * holds. The Gateway does every model call, so nothing here can be misused to
 * spend an AI provider key — there is none to leak.
 *
 * This points at the same Supabase project as the Gateway and the desktop app,
 * which is what makes an account here the same account there — same tenant,
 * same allowance, same history. It is not a detail of configuration but the
 * whole of how identity is shared across the family (docs/auth.md).
 */
let client: SupabaseClient | null = null;

export function supabaseBrowserClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Failing loudly here beats a sign-in screen that silently never works:
    // this is a build-time configuration mistake, not a user error.
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL と NEXT_PUBLIC_SUPABASE_ANON_KEY が設定されていません。",
    );
  }
  // Both values are opaque strings pasted from a dashboard that shows them one
  // above the other, so putting them in the wrong order is the likely mistake
  // rather than an unlikely one. Their shapes are unmistakable — a URL against
  // a JWT — and saying so costs one line, where the library's own message
  // ("Invalid supabaseUrl") sends the reader to look at the code instead.
  if (url.startsWith("eyJ") && anonKey.startsWith("http")) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL と NEXT_PUBLIC_SUPABASE_ANON_KEY の値が逆です。"
      + " URL（https://….supabase.co）と anon key（eyJ… で始まるJWT）を入れ替えてください。",
    );
  }
  if (!url.startsWith("http")) {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_URL が URL ではありません（https://….supabase.co の形）。現在の値の先頭: ${url.slice(0, 12)}…`,
    );
  }
  client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return client;
}
