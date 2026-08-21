/**
 * Which languages this app speaks, and which one it falls back to.
 *
 * English is the standard: it is what somebody gets when nothing about their
 * request says otherwise, and it is what a new language is added alongside.
 * Japanese is not a translation of an English product — the first users are in
 * Japan — but the product is not a Japanese one either, so the fallback has to
 * be the language with no assumptions in it.
 *
 * Unlike the product site (../web-product), the locale is NOT in the URL here.
 * That is the split every product of this shape makes: a marketing site needs
 * one address per language, because its addresses are what search engines and
 * shared links point at. An app needs one address, because language belongs to
 * the person and not to the door — and because this app's URL *is* its
 * installer (docs/capabilities.md §1), so there can only be one of it.
 *
 * Concretely, keeping the locale out of the path is also what keeps two things
 * working:
 *
 *  - `/auth/callback` never moves. Supabase matches its Redirect URLs on the
 *    whole string and, on a miss, sends the user silently to the Site URL —
 *    which is the Mac app's. A `/ja/auth/callback` would be exactly that miss
 *    (docs/log.md).
 *  - the QR points at one `/companion/[roomId]`. With a locale in the path, the
 *    sharing machine's language would either ride along to somebody else's
 *    phone or be dropped on the way.
 */
export const locales = ["en", "ja"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

/** Shown in the language menu, each in its own language. */
export const localeNames: Record<Locale, string> = {
  en: "English",
  ja: "日本語",
};

/** The explicit choice, once somebody makes one. Named as next-intl names it. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: string | undefined | null): value is Locale {
  return locales.includes(value as Locale);
}

/**
 * The language to render in, from an explicit choice or from the browser.
 *
 * An explicit choice wins forever: somebody who picked English on a Japanese
 * machine meant it, and re-deciding for them on the next request would make the
 * switcher look broken.
 *
 * Failing that, `Accept-Language` is read. This is the whole reason a Japanese
 * beginner — the person this product is for — is not shown an English screen
 * they cannot get out of. It is also why there is no redirect: the page is
 * rendered in the negotiated language at the same URL, so no `/` → `/ja` hop
 * can be cached and pinned to the wrong language for everyone (the shape of
 * failure this domain already hit once with apex/www).
 */
export function resolveLocale(input: {
  cookie: string | undefined;
  acceptLanguage: string | null;
}): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  return fromAcceptLanguage(input.acceptLanguage);
}

/**
 * Best match out of an `Accept-Language` header.
 *
 * Parsed rather than string-matched: "ja" must not be found inside an unrelated
 * tag, and a browser that asks for `en;q=0.9, ja;q=0.4` is asking for English.
 */
export function fromAcceptLanguage(header: string | null): Locale {
  if (!header) return defaultLocale;

  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      const quality = q === undefined ? 1 : Number.parseFloat(q);
      return { tag: tag.trim().toLowerCase(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    // A tag with q=0 is a language the browser is saying it does not want.
    .filter((entry) => entry.tag.length > 0 && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of ranked) {
    if (tag === "*") return defaultLocale;
    // "ja-JP" and "en-GB" are this app's "ja" and "en": we have nothing more
    // specific to offer, and refusing the region would drop the match entirely.
    const base = tag.split("-")[0];
    if (isLocale(base)) return base;
  }
  return defaultLocale;
}

/**
 * What the Gateway calls this language.
 *
 * Its `preferences.output_language` is a word, not a tag, so the mapping lives
 * here — next to the locales — rather than at each call site.
 */
export function outputLanguageFor(locale: string): "japanese" | "english" {
  return locale === "ja" ? "japanese" : "english";
}
