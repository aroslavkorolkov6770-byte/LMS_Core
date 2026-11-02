/** @type {import('next').NextConfig} */
const path = require("node:path");
const nextConfig = {
  distDir: process.env.CORE_NEXT_DIST_DIR || ".next",
  typedRoutes: false,
  devIndicators: false,
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  webpack(config) {
    // Pin the TS entry: stale emitted JS beside it must not shadow new exports.
    config.resolve.alias = { ...config.resolve.alias, "@lms-core/shared$": path.resolve(__dirname, "../../packages/shared/src/index.ts") };
    return config;
  }
};

module.exports = nextConfig;
