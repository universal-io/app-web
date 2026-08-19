import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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

export default nextConfig;
