import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 网页前端构建配置。入口在 src/gui/web（index.html + main.tsx），
// 产物输出到 dist/gui，由 src/gui/server.ts 以静态文件方式提供。
export default defineConfig({
  root: 'src/gui/web',
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('dist/gui', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
