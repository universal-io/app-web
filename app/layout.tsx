import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Noto_Sans_JP } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Universal I/O",
  description: "いま見ている画面を、AIに見てもらう。",
  // Launched from the Home Screen, iOS drops the address bar and tab strip —
  // the only way to stop browser chrome from covering the mirror in landscape.
  appleWebApp: { capable: true, title: "Universal I/O", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  // The pages a browser shows its chrome next to are the white entry pages;
  // the mirror is dark but paints its own full-screen surface either way.
  themeColor: "#ffffff",
  // The mirror fills the screen, so it has to reach under the notch and the
  // home indicator; the layouts pad themselves back out with safe-area insets.
  viewportFit: "cover",
  // Pinch-zooming a frozen screenshot is useful. Not disabled.
  userScalable: true,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} ${notoSansJP.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-white font-sans text-ink">{children}</body>
    </html>
  );
}
