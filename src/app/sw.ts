/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope & {
  __SW_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// Minimal Serwist type used only to satisfy TypeScript linting in service worker context
type SerwistOptions = {
  precacheEntries?: Array<{ url: string; revision: string | null }>;
  skipWaiting?: boolean;
  clientsClaim?: boolean;
  navigationPreload?: boolean;
  runtimeCaching?: unknown;
  disableDevLogs?: boolean;
};

type SerwistClass = new (opts: SerwistOptions) => { addEventListeners: () => void };

// 加载 CDN 脚本，Serwist 挂在全局
importScripts('https://unpkg.com/@serwist/sw@9.2.1/dist/index.js');

import('@serwist/next/worker').then(({ defaultCache }) => {
  // 运行时全局取值，不依赖任何 import 类型
  const Serwist = (self as unknown as { Serwist?: SerwistClass }).Serwist as SerwistClass | undefined;
  if (!Serwist) return;
  new Serwist({
    precacheEntries: self.__SW_MANIFEST,
    skipWaiting: true,
    clientsClaim: true,
    navigationPreload: true,
    runtimeCaching: defaultCache,
    disableDevLogs: true,
  }).addEventListeners();
});