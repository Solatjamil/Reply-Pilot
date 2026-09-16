import type { NextConfig } from "next";

// `output: "standalone"` produces the self-contained bundle the Docker image
// needs, but it must NOT be set on Vercel: the builder then looks for
// .next/next-server.js.nft.json, which standalone output writes inside
// .next/standalone/ instead, and the deploy fails after a successful build.
// The Dockerfile sets NEXT_STANDALONE=1; nothing else should.
const standalone = process.env.NEXT_STANDALONE === "1";

const nextConfig: NextConfig = {
  ...(standalone ? { output: "standalone" as const } : {}),
  // Prisma's generated client + native drivers must stay external to the bundle.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "@prisma/adapter-better-sqlite3", "pg", "better-sqlite3"],
  images: {
    // Platform avatars come from many CDNs; we render them with plain <img>
    // to avoid the optimizer needing network egress in the preview sandbox.
    unoptimized: true,
  },
  experimental: {
    // Worker route handlers must return within Meta's 5-second webhook SLA.
    proxyTimeout: 60_000,
  },
};

export default nextConfig;
