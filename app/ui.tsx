"use client";

import { useSyncExternalStore } from "react";
import { useLocale } from "next-intl";
import { SiteFooter, SiteHeader } from "@/app/chrome";

/**
 * Whether this is running in the browser yet.
 *
 * Capability checks — is there a `getDisplayMedia` here at all — can only be
 * answered on the client, but answering differently during hydration than the
 * server did breaks it. This returns false on the server and true once
 * hydrated, which is exactly the distinction those checks need.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: "warn" | "error";
  children: React.ReactNode;
}) {
  // One light style each. These render on the white entry pages and inside the
  // dark mirror panels alike, and a solid light background stays readable on
  // both — where the OS-preference dark: variant matched neither reliably.
  const styles = tone === "error"
    ? "border-red-200 bg-red-50 text-red-800"
    : "border-amber-200 bg-amber-50 text-amber-900";
  return <p className={`rounded-lg border px-3 py-2 text-sm ${styles}`}>{children}</p>;
}

/**
 * The frame every entry page sits in: the shared site chrome above and below,
 * the page in a readable column between. The mirror views do not use it — they
 * own the whole screen.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  // The chrome links across to the product site, which does put the locale in
  // its paths — so it has to be told which language this page is being read in.
  const locale = useLocale();
  return (
    <>
      <SiteHeader locale={locale} />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-5 py-8 sm:px-10 sm:py-10">
        {children}
      </main>
      <SiteFooter locale={locale} />
    </>
  );
}
