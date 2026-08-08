import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Electron 生产环境通过 file:// 加载，因此使用相对路径 base
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome130',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
