import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 어디서 켜도 되게 — 저장소 폴더 기준 (이 파일은 tests/ui 안)
const ROOT = resolve(__dirname, '../..')

export default defineConfig({
  root: resolve(ROOT, 'tests/ui'),
  resolve: {
    alias: {
      '@renderer': resolve(ROOT, 'src/renderer/src'),
      '@shared': resolve(ROOT, 'src/shared')
    }
  },
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5189,
    strictPort: true,
    fs: { allow: [ROOT] }
  }
})
