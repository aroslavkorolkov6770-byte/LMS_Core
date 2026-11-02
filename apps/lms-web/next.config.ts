import type { NextConfig } from "next";
import path from "node:path";
import { existsSync } from "node:fs";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  webpack(config) {
    const sharedEntry = path.resolve(__dirname, "../../packages/shared/src/index.ts");
    if (existsSync(sharedEntry)) config.resolve.alias = { ...config.resolve.alias, "@lms-core/shared$": sharedEntry };
    return config;
  },
  /* Здесь можно добавлять другие настройки, например, домены для картинок */
  
  // Мы не добавляем сюда блоки typescript и eslint с флагами ignore, 
  // поэтому Next.js будет использовать стандартное поведение: 
  // полная проверка перед деплоем.
};

export default nextConfig;
