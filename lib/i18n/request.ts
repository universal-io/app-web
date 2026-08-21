import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, resolveLocale } from "@/lib/i18n/routing";

/**
 * The language for this request.
 *
 * Same shape as the product site's `src/i18n/request.ts`, with one difference:
 * there is no `[locale]` segment to read, so the locale is negotiated here
 * instead — an explicit choice from the cookie, otherwise `Accept-Language`.
 *
 * Reading either one opts the page into dynamic rendering. That is the price of
 * a single URL that answers in the visitor's language, and it is a low one
 * here: this page starts an auth check and a screen capture the moment it
 * loads, so it was never going to be served as a static file.
 */
export default getRequestConfig(async () => {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerList.get("accept-language"),
  });

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
