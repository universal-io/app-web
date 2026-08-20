import Link from "next/link";

/**
 * The site chrome the entry pages share with the product site.
 *
 * The product site lives in another repository (../web-product) and is served
 * from /product/* through the multi-zone rewrite, so nothing here can be
 * imported from it — these are hand-kept copies of its Nav and Footer, reduced
 * to what the app needs. The links cross a zone boundary, which is why they
 * are plain <a> elements rather than next/link: the destination is another
 * deployment, not another route of this one.
 *
 * Only the entry pages wear this chrome. The mirror views own the whole
 * screen, and a header over somebody's shared screen would be covering the
 * thing they are trying to ask about.
 */

/** The text wordmark, written the same way everywhere: I//O with the brand
 * iris on the slashes. The product site's Nav and Footer write it exactly
 * like this. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={className}>
      I<span className="text-iris">{"//"}</span>O
    </span>
  );
}

/** Where the Japanese product pages live behind the /product rewrite:
 * web-product's default locale (en) has no prefix, so ja pages sit under
 * /product/ja. The app speaks Japanese, so it links there. */
const PRODUCT = "/product/ja";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-hair bg-white/85 backdrop-blur-xl">
      <div className="flex items-center justify-between px-5 py-3.5 sm:px-10 sm:py-[18px]">
        <Link href="/" className="flex items-baseline gap-2.5 text-ink">
          <Wordmark className="text-[19px] font-bold tracking-[-0.02em]" />
          <span className="hidden text-[13px] font-medium tracking-[0.01em] text-slate min-[420px]:inline">
            Universal I/O
          </span>
        </Link>
        <nav className="flex items-center gap-6 sm:gap-7">
          <a
            href={PRODUCT}
            className="text-sm font-medium text-body transition-colors hover:text-ink"
          >
            製品情報
          </a>
          <a
            href={`${PRODUCT}/pricing`}
            className="text-sm font-medium text-body transition-colors hover:text-ink"
          >
            料金
          </a>
        </nav>
      </div>
    </header>
  );
}

const legalLinks = [
  { href: `${PRODUCT}/company`, label: "会社概要" },
  { href: `${PRODUCT}/privacy`, label: "プライバシーポリシー" },
  { href: `${PRODUCT}/terms`, label: "利用規約" },
  // Required to be reachable before purchase for Japanese customers
  // (特定商取引法), same as on the product site.
  { href: `${PRODUCT}/commerce-disclosure`, label: "特定商取引法に基づく表記" },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-hair bg-white">
      <div className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-x-8 gap-y-5 px-5 py-9 sm:px-10">
        <div className="flex items-baseline gap-3">
          <Wordmark className="text-base font-bold" />
          <span className="font-mono text-xs text-faint">universal-io.com</span>
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
          <span className="font-mono text-xs text-faint">macOS · iOS · Web</span>
          <span className="text-[13px] text-faint">© 2026 Universal I/O</span>
        </div>
      </div>
    </footer>
  );
}
