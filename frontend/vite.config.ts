import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const API_BASE_URL = env.API_BASE_URL || 'http://localhost:3001'
  // 开发环境使用 '/'，生产环境使用 '/frontend/'
  const base = mode === 'development' ? '/' : '/frontend/'
  return {
    plugins: [vue(), tailwindcss()],
    base,
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
          target: API_BASE_URL,
          changeOrigin: true,
        },
        '/hls': {
          target: API_BASE_URL,
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
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          // 静态资源分类存放
          assetFileNames: 'assets/[name]-[hash][extname]',
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js',
          manualChunks(id: string) {
            if (id.includes('node_modules/hls.js')) return 'hls'
            if (
              id.includes('node_modules/vue') ||
              id.includes('node_modules/pinia') ||
              id.includes('node_modules/@vue')
            )
              return 'vendor'
          },
        },
      },
    },
  }
})
