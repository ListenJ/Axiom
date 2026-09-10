import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  server: {
    port: 18789,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    host: 'localhost',
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'es2021',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // 供应商分包：主 chunk 只保留应用代码，路由级懒加载见 src/App.tsx
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('framer-motion')) return 'vendor-motion'
          if (id.includes('@xterm')) return 'vendor-xterm'
          if (id.includes('marked') || id.includes('highlight.js')) return 'vendor-markdown'
          if (id.includes('lucide-react')) return 'vendor-lucide'
          if (id.includes('react-router') || id.includes('react-dom') || id.includes('react/') || id.includes('/react.')) return 'vendor-react'
          return 'vendor-other'
        },
      },
    },
  },
})