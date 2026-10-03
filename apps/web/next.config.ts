import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// Single .env at the repository root
loadEnvConfig(path.resolve(__dirname, "../.."));

const nextConfig: NextConfig = {
  transpilePackages: ["@iso-dms/shared"],
};

export default nextConfig;
