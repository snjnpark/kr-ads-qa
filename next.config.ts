import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_LAYA_TEST_MODE: "0", NEXT_PUBLIC_LAYA_LOCAL_SWITCH: "0" },
  webpack(config) {
    config.watchOptions = { ...config.watchOptions, ignored: ["**/node_modules/**", "**/.git/**", "**/.next/**", "**/data/**", "**/output/**", "**/policies/local/**"] };
    return config;
  },
  reactStrictMode: true,
  serverExternalPackages: ["@receptron/laya", "onnxruntime-node", "@napi-rs/keyring"],
  poweredByHeader: false,
  turbopack: { root: process.cwd() },
  outputFileTracingExcludes: { "/*": ["./data/**/*", "./output/**/*", "./policies/local/**/*", "./config/**/*", "./.env*", "./.git/**/*", "./.playwright-cli/**/*"] },
  outputFileTracingIncludes: { "/api/*": ["./policies/default.yaml"] },
};

export default nextConfig;
