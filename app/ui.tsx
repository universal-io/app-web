"use client";

import { useSyncExternalStore } from "react";

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
  const styles = tone === "error"
    ? "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
    : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200";
  return <p className={`rounded-lg border px-3 py-2 text-sm ${styles}`}>{children}</p>;
}

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      {children}
    </main>
  );
}
