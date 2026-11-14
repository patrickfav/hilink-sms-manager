import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'frontend',
  plugins: [preact(), tailwindcss()],
  build: { outDir: '../frontend-dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        configure: proxy => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.host) proxyReq.setHeader('X-Forwarded-Host', req.headers.host)
          })
        },
      },
      '/healthz': 'http://127.0.0.1:8080',
    },
  },
  test: { environment: 'jsdom', setupFiles: './src/test-setup.ts' },
})
