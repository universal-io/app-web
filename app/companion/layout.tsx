import type { Viewport } from "next";
import type { ReactNode } from "react";

/**
 * A companion has its own, image-level pinch canvas. Letting Safari scale the
 * document as well would enlarge the toolbar and question field together with
 * the shared screen, leaving two competing zoom systems. Other routes retain
 * normal browser zoom through the root layout.
 */
export const viewport: Viewport = {
  themeColor: "#000000",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: "resizes-content",
};

export default function CompanionLayout({ children }: { children: ReactNode }) {
  return children;
}
