import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Noto_Sans_JP } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import "./globals.css";

// The same three families, in the same order, as the product site
// (../web-product): Geist carries the Latin, Noto Sans JP the Japanese.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const notoSansJP = Noto_Sans_JP({
  variable: "--font-noto-jp",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return {
    metadataBase: new URL("https://universal-io.com"),
    title: t("name"),
    description: t("tagline"),
    // Launched from the Home Screen, iOS drops the address bar and tab strip —
    // the only way to stop browser chrome from covering the mirror in landscape.
    appleWebApp: { capable: true, title: t("name"), statusBarStyle: "black-translucent" },
  };
}

export const viewport: Viewport = {
  // The pages a browser shows its chrome next to are the white entry pages;
  // the mirror is dark but paints its own full-screen surface either way.
  themeColor: "#ffffff",
  // The mirror fills the screen, so it has to reach under the notch and the
  // home indicator; the layouts pad themselves back out with safe-area insets.
  viewportFit: "cover",
  // Browser zoom remains available on the entry pages. The companion handles
  // pinching inside a frozen screen itself so only the picture — not its fixed
  // controls or answer form — changes size.
  userScalable: true,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Negotiated per request from the cookie or Accept-Language, not read out of
  // the URL: there is one address here, and it answers in the visitor's
  // language (lib/i18n/routing.ts).
  const locale = await getLocale();

  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} ${notoSansJP.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-white font-sans text-ink">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
