import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve('tests/ui'),
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5189,
    strictPort: true,
    fs: { allow: [resolve('.')] }
  }
})
