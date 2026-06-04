import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  base: '/frontend/',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/hls': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    // 构建输出到后端 public 目录，由 Express 作为静态文件 serve
    outDir: resolve(__dirname, '..', 'public', 'frontend'),
    emptyOutDir: true,
    // 所有静态资源内联阈值 (bytes)，小于此值的资源会被内联到 JS/CSS
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        // 静态资源分类存放
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
})
