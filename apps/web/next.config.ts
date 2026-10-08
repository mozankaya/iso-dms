import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// Single .env at the repository root
loadEnvConfig(path.resolve(__dirname, "../.."));

const nextConfig: NextConfig = {
  transpilePackages: ["@iso-dms/shared"],
  // The Docker image runs the traced minimal server (apps/web/Dockerfile sets this). Left off elsewhere: on Windows
  // the build cannot create the symbolic links the standalone folder needs.
  ...(process.env.NEXT_OUTPUT === "standalone" && {
    output: "standalone" as const,
    // The monorepo root, so the shared package that sits outside apps/web is traced too
    outputFileTracingRoot: path.resolve(__dirname, "../.."),
  }),
};

export default nextConfig;
