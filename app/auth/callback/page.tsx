import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { Shell } from "@/app/ui";
import { AuthCallback } from "@/app/auth/callback/callback";

/**
 * Where Google sends the browser back to.
 *
 * The handler reads the query string, which App Router requires be wrapped in
 * Suspense so the rest of the page can still be prerendered.
 */
export default async function AuthCallbackPage() {
  const t = await getTranslations("auth");
  return (
    <Suspense fallback={<Shell><p className="text-slate">{t("confirming")}</p></Shell>}>
      <AuthCallback />
    </Suspense>
  );
}
