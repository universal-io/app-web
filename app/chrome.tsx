"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import LanguageSwitcher from "@/app/language-switcher";
import { MACOS_DOWNLOAD_URL } from "@/lib/download";

/**
 * The site chrome, ported from ../web-product/src/components/{Nav,Footer}.tsx.
 *
 * Those files could not be imported: the product site is a separate repository
 * and a separate Vercel project, served under /product/* through the multi-zone
 * rewrite. So they are copied — markup, classes and message keys as they are
 * there, including `nav.*` and `footer.*` verbatim, so the two headers say the
 * same words in the same places rather than each having its own wording.
 *
 * Three adaptations, all forced:
 *
 *  1. Destinations that cross the zone boundary are plain <a>. next/link would
 *     try to client-navigate to a route this deployment does not have.
 *  2. The nav's own links are gone: the product site's nav names whole pages of
 *     itself, and this deployment has one page. What remains points across.
 *  3. Language is switched by cookie rather than by URL — see
 *     app/language-switcher.tsx.
 *
 * The download CTA is kept, and it is not decoration. The browser cannot read
 * real coordinates or draw on the actual screen (README, capabilities §6), so
 * anybody who gets far enough to want that needs the Mac app; the way there
 * belongs in front of them.
 *
 * Only the entry pages wear this chrome. The mirror owns the whole screen — a
 * header over somebody's shared screen covers the thing they are asking about.
 */

/** The wordmark, written exactly as the product site's Nav and Footer write
 * it: the letters in the surrounding colour, the slashes in brand iris. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      I<span className="text-iris">{"//"}</span>O
    </span>
  );
}

/** The product site's default locale has no prefix, so its Japanese pages sit
 * under /product/ja. Which one this app links to follows the language it is
 * being read in — sending a Japanese reader to an English page would undo the
 * negotiation that put them in Japanese. */
function productPaths(locale: string) {
  const base = locale === "en" ? "/product" : `/product/${locale}`;
  return {
    product: base,
    pricing: `${base}/pricing`,
    company: `${base}/company`,
    privacy: `${base}/privacy`,
    terms: `${base}/terms`,
    commerceDisclosure: `${base}/commerce-disclosure`,
  };
}

export function SiteHeader({ locale }: { locale: string }) {
  const t = useTranslations("nav");
  const paths = productPaths(locale);
  const [open, setOpen] = useState(false);

  const links = [
    { href: paths.product, label: t("product") },
    // Somebody deciding whether to pay should be able to reach the terms of
    // that decision from anywhere on the site.
    { href: paths.pricing, label: t("pricing") },
  ];

  useEffect(() => {
    if (!open) return;
    document.documentElement.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const mq = window.matchMedia("(min-width: 768px)");
    const onMq = () => {
      if (mq.matches) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    mq.addEventListener("change", onMq);
    return () => {
      document.documentElement.style.overflow = "";
      window.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onMq);
    };
  }, [open]);

  return (
    <>
      <nav className="sticky top-0 z-50 flex items-center justify-between border-b border-hair bg-white/85 px-5 py-3.5 backdrop-blur-xl sm:px-10 sm:py-[18px]">
        <Link
          href="/"
          onClick={() => setOpen(false)}
          className="flex items-baseline gap-2.5 text-ink"
        >
          <Wordmark className="text-[19px] font-bold tracking-[-0.02em]" />
          <span className="hidden text-[13px] font-medium tracking-[0.01em] text-slate min-[420px]:inline">
            Universal I/O
          </span>
        </Link>

        {/* desktop */}
        <div className="hidden items-center gap-7 md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-body transition-colors hover:text-ink"
            >
              {l.label}
            </a>
          ))}
          <LanguageSwitcher />
          <a
            href={MACOS_DOWNLOAD_URL}
            className="rounded-[10px] bg-ink px-[18px] py-2.5 text-sm font-semibold text-white transition-colors hover:bg-iris"
          >
            {t("cta")}
          </a>
        </div>

        {/* mobile */}
        <div className="flex items-center gap-2.5 md:hidden">
          <LanguageSwitcher />
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-label={open ? t("closeMenu") : t("openMenu")}
            aria-expanded={open}
            className="relative flex h-10 w-10 items-center justify-center rounded-[10px] border border-line bg-white transition-colors active:bg-paper"
          >
            <span
              className={`absolute h-[1.6px] w-[18px] rounded-full bg-ink transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                open ? "rotate-45" : "-translate-y-[5px]"
              }`}
            />
            <span
              className={`absolute h-[1.6px] w-[18px] rounded-full bg-ink transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                open ? "-rotate-45" : "translate-y-[5px]"
              }`}
            />
          </button>
        </div>
      </nav>

      {/* mobile overlay menu */}
      <div
        aria-hidden={!open}
        className={`fixed inset-0 z-40 md:hidden ${
          open ? "visible" : "invisible"
        } transition-[visibility] duration-500`}
      >
        <div
          onClick={() => setOpen(false)}
          className={`absolute inset-0 bg-white/90 backdrop-blur-2xl transition-opacity duration-400 ${
            open ? "opacity-100" : "opacity-0"
          }`}
        />
        <div className="relative flex h-full flex-col overflow-y-auto px-6 pb-10 pt-[92px]">
          <div className="flex flex-col">
            {links.map((l, i) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                style={{ transitionDelay: open ? `${90 + i * 55}ms` : "0ms" }}
                className={`flex items-center justify-between border-b border-hair py-[18px] text-[26px] font-semibold tracking-[-0.02em] text-ink transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                  open ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
                }`}
              >
                {l.label}
                <span className="font-mono text-sm text-ghost">{"//"}</span>
              </a>
            ))}
          </div>
          <div
            style={{ transitionDelay: open ? "340ms" : "0ms" }}
            className={`mt-auto flex flex-col gap-4 pt-10 transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              open ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
            }`}
          >
            <a
              href={MACOS_DOWNLOAD_URL}
              onClick={() => setOpen(false)}
              className="rounded-xl bg-ink px-7 py-4 text-center text-base font-semibold text-white transition-colors active:bg-iris"
            >
              {t("cta")}
            </a>
            <div className="text-center font-mono text-xs tracking-[0.06em] text-faint">
              macOS · iOS · universal-io.com
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function SiteFooter({ locale }: { locale: string }) {
  const t = useTranslations("footer");
  const paths = productPaths(locale);

  const legalLinks = [
    { href: paths.company, label: t("company") },
    { href: paths.privacy, label: t("privacy") },
    { href: paths.terms, label: t("terms") },
    // Required to be reachable before purchase for Japanese customers
    // (特定商取引法), so it belongs in the footer rather than behind a signup.
    { href: paths.commerceDisclosure, label: t("commerceDisclosure") },
  ];

  return (
    <footer className="border-t border-hair bg-white">
      <div className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-x-8 gap-y-5 px-5 py-9 sm:px-10">
        <div className="flex items-baseline gap-3">
          <Wordmark className="text-base font-bold" />
          <span className="font-mono text-xs text-faint">{t("domain")}</span>
        </div>
        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {legalLinks.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-[13px] text-body transition-colors hover:text-ink"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-6">
          <span className="font-mono text-xs text-faint">{t("platforms")}</span>
          <span className="text-[13px] text-faint">{t("copyright")}</span>
        </div>
      </div>
    </footer>
  );
}
