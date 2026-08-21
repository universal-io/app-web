"use server";

import { cookies } from "next/headers";
import { LOCALE_COOKIE, isLocale } from "@/lib/i18n/routing";

/**
 * Records an explicit language choice.
 *
 * The product site switches language by navigating to the other locale's URL.
 * There are no other URLs here — the locale is not in the path — so the choice
 * is written down instead, and it outranks `Accept-Language` from then on
 * (lib/i18n/routing.ts). A year is long enough that nobody has to make the same
 * choice twice; `lax` because this is a preference, not a credential.
 */
export async function chooseLocale(next: string): Promise<void> {
  if (!isLocale(next)) return;
  const store = await cookies();
  store.set(LOCALE_COOKIE, next, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}
