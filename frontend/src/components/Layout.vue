<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import Sidebar from './Sidebar.vue'
import { useAppStore } from '@/stores/app'

defineSlots<{
  default(): unknown
}>()

const appStore = useAppStore()

// 侧边栏折叠状态同步
const sidebarCollapsed = ref(localStorage.getItem('sidebar-collapsed') === 'true')
watch(
  () => localStorage.getItem('sidebar-collapsed'),
  (val) => {
    sidebarCollapsed.value = val === 'true'
  },
)

// 监听 storage 事件（跨组件同步）
window.addEventListener('storage', (e) => {
  if (e.key === 'sidebar-collapsed') {
    sidebarCollapsed.value = e.newValue === 'true'
  }
})

onMounted(() => {
  appStore.fetchHealth()
})
</script>

<template>
  <div class="min-h-screen">
    <Sidebar @update:collapsed="sidebarCollapsed = $event" />
    <div
      class="transition-[margin] duration-200"
      :class="sidebarCollapsed ? 'lg:ml-16' : 'lg:ml-56'"
    >
      <main class="px-4 py-6 mx-auto w-full">
        <slot />
      </main>
      <footer
        class="text-center text-xs text-gray-400 py-4 border-t border-gray-200 flex flex-wrap items-center justify-center gap-x-6 gap-y-1"
      >
        <span>
          <strong class="text-gray-500">系统启动时间:</strong>
          {{ $formatTime(appStore.serverStartTime) }}
        </span>
        <span>
          <strong class="text-gray-500">应用版本:</strong>
          v{{ appStore.appVersion || '-' }}
        </span>
        <span>
          <strong class="text-gray-500">Docker 镜像版本:</strong>
          {{ appStore.dockerImageVersion || '-' }}
        </span>
      </footer>
    </div>
  </div>
</template>
