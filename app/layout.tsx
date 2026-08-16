import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Universal I/O",
  description: "いま見ている画面を、AIに見てもらう。",
  // Launched from the Home Screen, iOS drops the address bar and tab strip —
  // the only way to stop browser chrome from covering the mirror in landscape.
  appleWebApp: { capable: true, title: "Universal I/O", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#000000",
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
