import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// 开发时代理目标：本机 Lachesis 服务。端口以服务端实际监听为准，
// 可用 LACHESIS_API_ORIGIN 覆盖，例如：
//   LACHESIS_API_ORIGIN=http://127.0.0.1:3000 pnpm dev
const apiOrigin = process.env.LACHESIS_API_ORIGIN ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@lachesis/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: false,
      },
    },
  },
})
