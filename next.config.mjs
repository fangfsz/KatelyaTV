/* eslint-disable @typescript-eslint/no-var-requires */
import { withSerwist } from '@serwist/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: { dirs: ['src'] },
  reactStrictMode: false,
  swcMinify: true,

  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http', hostname: '**' },
    ],
  },

  webpack(config) {
    // SVG 处理规则（保持原有逻辑）
    const fileLoaderRule = config.module.rules.find((rule) =>
      rule.test?.test?.('.svg')
    );
    config.module.rules.push(
      { ...fileLoaderRule, test: /\.svg$/i, resourceQuery: /url/ },
      {
        test: /\.svg$/i,
        issuer: { not: /\.(css|scss|sass)$/ },
        resourceQuery: { not: /url/ },
        loader: '@svgr/webpack',
        options: { dimensions: false, titleProp: true },
      }
    );
    fileLoaderRule.exclude = /\.svg$/i;

    // 屏蔽 Node 模块（Edge 友好）
    config.resolve.fallback = {
      ...config.resolve.fallback,
      net: false,
      tls: false,
      crypto: false,
    };
    return config;
  },
};

// Serwist 配置（等效原 next-pwa 能力）
export default withSerwist({
  swSrc: './src/app/sw.ts',
  swDest: 'public/sw.js',
  cacheOnNavigation: true,
  // 如需自定义缓存策略，在此追加 runtimeCaching 数组
})(nextConfig);
