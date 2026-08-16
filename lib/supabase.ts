"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The browser's Supabase session, which is the only credential this client
 * holds. The Gateway does every model call, so nothing here can be misused to
 * spend an AI provider key — there is none to leak.
 *
 * M1 signs in with an existing account. The anonymous guest flow that makes
 * "open a link and go" real needs a `guest` plan and a provisioning branch that
 * do not exist in the Gateway yet (app-web/docs/requirements.md §5-D), and
 * shipping without it would only mean a sign-in wall, not a broken product.
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
  client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return client;
}
