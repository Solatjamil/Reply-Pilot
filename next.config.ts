import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle used by the Docker image.
  output: 'standalone',
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
