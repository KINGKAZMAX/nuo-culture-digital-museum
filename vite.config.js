import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径 base，兼容 GitHub Pages 子路径部署与本地 preview
  base: './',
  server: { host: true, port: 5188 },
  preview: { host: true, port: 5188 },
  build: {
    chunkSizeWarningLimit: 6000,
    assetsInlineLimit: 0
  }
});
