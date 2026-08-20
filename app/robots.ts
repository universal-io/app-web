import type { MetadataRoute } from "next";

/**
 * robots.txt for the whole domain.
 *
 * It lives here rather than with the marketing site because only the project
 * holding the root of universal-io.com can serve /robots.txt at all — under
 * web-product's basePath it would be published at /product/robots.txt, which
 * no crawler looks for. The sitemap it points at is still web-product's, and
 * is reached through the /product rewrite in next.config.ts.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://universal-io.com/product/sitemap.xml",
  };
}
