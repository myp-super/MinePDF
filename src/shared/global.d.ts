import type { PkmApi } from './types';

declare global {
  interface Window {
    /** preload 注入的主进程桥接 API */
    pkm: PkmApi;
  }
}

export {};
