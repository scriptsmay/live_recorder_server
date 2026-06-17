<script setup lang="ts">
import { useRoute } from 'vue-router'

const route = useRoute()

interface NavItem {
  label: string
  to: string
}

const navItems: NavItem[] = [
  { label: '仪表盘', to: '/dashboard' },
  { label: '直播间', to: '/rooms' },
  { label: '录制会话', to: '/sessions' },
  { label: '录制文件', to: '/recordings' },
  { label: '转码记录', to: '/transcode' },
  { label: '弹幕工具箱', to: '/danmaku-toolbox' },
  { label: '回放工具箱', to: '/replay-toolbox' },
  { label: '投稿管理', to: '/templates' },
  { label: '投稿记录', to: '/upload-records' },
  { label: '设置', to: '/settings' },
  { label: '日志', to: '/logs' },
  { label: 'API 文档', to: '/api-doc' },
]

function isActive(item: NavItem) {
  return route.path === item.to || route.path.startsWith(item.to + '/')
}
</script>

<template>
  <nav class="bg-gray-900 border-b-2 border-brand-500 sticky top-0 z-50 shadow-sm">
    <div class="mx-auto px-4">
      <div class="flex items-center justify-between h-14">
        <!-- 品牌标识 -->
        <router-link
          to="/dashboard"
          class="text-white font-semibold text-lg tracking-wide shrink-0 hover:text-brand-400 transition-colors"
        >
          <img src="/logo.svg" alt="Live Recorder" class="h-6 inline-block align-middle" />
          K-Recorder
        </router-link>

        <!-- 桌面导航 -->
        <div class="hidden lg:flex items-center gap-1 overflow-x-auto">
          <router-link
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="px-3 py-1.5 rounded text-sm whitespace-nowrap transition-colors"
            :class="
              isActive(item)
                ? 'text-white bg-brand-600'
                : 'text-gray-300 hover:text-white hover:bg-gray-700'
            "
          >
            {{ item.label }}
          </router-link>
        </div>

        <!-- 移动端折叠按钮 -->
        <details class="lg:hidden relative">
          <summary class="list-none cursor-pointer text-gray-300 hover:text-white p-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </summary>
          <div
            class="absolute right-0 top-full mt-2 w-48 bg-gray-800 rounded-lg shadow-xl border border-gray-700 py-2 z-50"
          >
            <router-link
              v-for="item in navItems"
              :key="item.to"
              :to="item.to"
              class="block px-4 py-2 text-sm transition-colors"
              :class="
                isActive(item)
                  ? 'text-white bg-brand-600'
                  : 'text-gray-300 hover:text-white hover:bg-gray-700'
              "
            >
              {{ item.label }}
            </router-link>
          </div>
        </details>
      </div>
    </div>
  </nav>
</template>
