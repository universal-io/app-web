import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Same plugin, same purpose, as the product site: it points next-intl at the
// request configuration. Ours negotiates the locale from the request instead of
// reading it out of the URL (lib/i18n/routing.ts explains why).
const withNextIntl = createNextIntlPlugin("./lib/i18n/request.ts");

/**
 * The marketing site lives in another repository (../web-product) and another
 * Vercel project, but under this domain: the app owns the root — the URL is
 * the installer — and everything that *describes* the product sits under
 * /product. This is Vercel's multi-zone arrangement: the paths below are
 * proxied server-side to web-product's production deployment, which serves
 * them itself (its next.config sets basePath "/product").
 */
const PRODUCT_SITE = "https://web-product-kaya-matsumotos-projects.vercel.app";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/product", destination: `${PRODUCT_SITE}/product` },
      { source: "/product/:path*", destination: `${PRODUCT_SITE}/product/:path*` },
    ];
  },
  // The product used to live at /solo and the watching side at /watch.
  // Links to both are in the wild (shared chats, camera-scanned QRs), so the
  // old addresses keep working. Not permanent: browsers cache 308s hard, and
  // these paths may yet be wanted for something else.
  async redirects() {
    return [
      { source: "/solo", destination: "/", permanent: false },
      { source: "/watch/:roomId", destination: "/companion/:roomId", permanent: false },
    ];
  },
};

export default withNextIntl(nextConfig);
