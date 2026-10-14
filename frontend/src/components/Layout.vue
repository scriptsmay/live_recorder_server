<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Sidebar from './Sidebar.vue'
import ThemeToggle from './ThemeToggle.vue'
import { useAppStore } from '@/stores/app'

defineSlots<{
  default(): unknown
}>()

const appStore = useAppStore()
const route = useRoute()

const pageTitle = computed(() => (route.meta.title as string) || '')

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
      <header class="sticky top-0 z-40 border-b border-gray-200 bg-surface/80 backdrop-blur-xl">
        <div
          class="mx-auto flex h-14 w-full max-w-[1600px] items-center justify-between pl-14 pr-4 sm:pl-14 sm:pr-6 lg:px-8"
        >
          <h2 class="truncate text-sm font-medium text-gray-900">{{ pageTitle }}</h2>
          <ThemeToggle />
        </div>
      </header>
      <main class="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 mx-auto w-full max-w-[1600px]">
        <Transition name="page" mode="out-in">
          <div :key="route.path">
            <slot />
          </div>
        </Transition>
      </main>
      <footer
        class="text-center text-xs text-gray-400 py-4 border-t border-gray-200 flex flex-wrap items-center justify-center gap-x-6 gap-y-1"
      >
        <span>
          <strong class="text-gray-500 font-medium">系统启动时间:</strong>
          {{ $formatTime(appStore.serverStartTime) }}
        </span>
        <span>
          <strong class="text-gray-500 font-medium">应用版本:</strong>
          v{{ appStore.appVersion || '-' }}
        </span>
        <span>
          <strong class="text-gray-500 font-medium">Docker 镜像版本:</strong>
          {{ appStore.dockerImageVersion || '-' }}
        </span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.page-enter-active {
  transition: opacity 0.15s ease;
}
.page-leave-active {
  transition: opacity 0.1s ease;
}
.page-enter-from,
.page-leave-to {
  opacity: 0;
}
</style>
