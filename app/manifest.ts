import type { MetadataRoute } from "next";

/**
 * A page cannot hide Safari's own chrome. The tab strip that overlaps the
 * mirror in landscape belongs to the browser, and no API — not the Fullscreen
 * API, which iPhone Safari only grants to video elements — lets a site remove
 * it.
 *
 * Installing it does. Added to the Home Screen with `display: standalone`, iOS
 * launches the app without the address bar or tab strip, which is the only
 * route to a full-screen mirror on that platform.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Universal I/O",
    short_name: "Universal I/O",
    description: "いま見ている画面を、AIに見てもらう。",
    start_url: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      // The same brand mark the product site ships; Android's installer wants
      // a raster size to pick from.
      {
        src: "/icon.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
