import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Статический экспорт: `npm run build` кладёт готовый сайт в ./out.
   * Cloudflare Pages раздаёт эту папку без сервера и без воркеров.
   */
  output: "export",
  // Пути вида /works/slug/ — так Cloudflare Pages отдаёт index.html без редиректов.
  trailingSlash: true,
  // Оптимизатор картинок Next требует сервера, в статике его нет.
  images: { unoptimized: true },
};

export default nextConfig;
