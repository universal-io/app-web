import { Suspense } from "react";
import { Shell } from "@/app/ui";
import { AuthCallback } from "@/app/auth/callback/callback";

/**
 * Where Google sends the browser back to.
 *
 * The handler reads the query string, which App Router requires be wrapped in
 * Suspense so the rest of the page can still be prerendered.
 */
export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<Shell><p className="text-slate-500">確認しています…</p></Shell>}>
      <AuthCallback />
    </Suspense>
  );
}
