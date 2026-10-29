import path from "node:path";
import type { NextConfig } from "next";

const testBuild = process.env.LAYA_BUILD_TARGET === "test";
const modelOrigin = process.env.NEXT_PUBLIC_LAYA_MODEL_BASE_URL ? new URL(process.env.NEXT_PUBLIC_LAYA_MODEL_BASE_URL).origin : "";
const contentSecurityPolicy = [
  "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:", "worker-src 'self' blob:",
  `connect-src 'self' https://graph.facebook.com https://googleads.googleapis.com https://apis.moment.kakao.com https://kapi.kakao.com https://huggingface.co https://*.hf.co ${modelOrigin}${process.env.NODE_ENV === "development" ? " ws: wss:" : ""}`,
].join("; ");
const nextConfig: NextConfig = {
  distDir: testBuild ? ".next-test" : ".next",
  typescript: { tsconfigPath: testBuild ? "tsconfig.test.json" : "tsconfig.json" },
  env: { NEXT_PUBLIC_LAYA_TEST_MODE: testBuild ? "1" : "0", NEXT_PUBLIC_LAYA_LOCAL_SWITCH: "0" },
  webpack(config) {
    config.resolve.alias["@browser-runtime"] = path.resolve(testBuild ? "./testing/browser-runtime.ts" : "./src/browser/runtime-factory.ts");
    config.watchOptions = { ...config.watchOptions, ignored: ["**/node_modules/**", "**/.git/**", "**/.next/**", "**/.next-test/**", "**/data/**", "**/output/**", "**/policies/local/**"] };
    return config;
  },
  reactStrictMode: true,
  serverExternalPackages: [],
  poweredByHeader: false,
  turbopack: { root: process.cwd(), resolveAlias: { "@browser-runtime": testBuild ? "./testing/browser-runtime.ts" : "./src/browser/runtime-factory.ts" } },
  outputFileTracingExcludes: { "/*": ["./public/models/**/*", "./.laya-model-downloads/**/*", "./data/**/*", "./output/**/*", "./policies/local/**/*", "./config/**/*", "./.env*", "./.git/**/*", "./.playwright-cli/**/*", ...(testBuild ? [] : ["./testing/**/*"]), "./tests-ts/**/*", "./tests-integration/**/*", "./e2e/**/*", "./scripts/**/*", "./docs/**/*", "./benchmarks/**/*", "./src/server/default-model.json", "./src/browser/model/releases/conditions-qualifier-v1.json", "./src/server/api.ts", "./src/server/application.ts", "./src/server/ai.ts", "./src/server/storage.ts", "./src/server/credentials.ts", "./node_modules/@playwright/**/*", "./node_modules/onnxruntime-node/**/*", "./node_modules/@napi-rs/**/*"] },
  logging: false,
  async headers() { return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: contentSecurityPolicy }, { key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Content-Type-Options", value: "nosniff" }, { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }] }, { source: "/models/kr-ads-qa/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] }]; },
  outputFileTracingIncludes: {},
};

export default nextConfig;
