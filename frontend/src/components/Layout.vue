<script setup lang="ts">
import { onMounted } from 'vue'
import Navbar from './Navbar.vue'
import { useAppStore } from '@/stores/app'

defineSlots<{
  default(): unknown
}>()

const appStore = useAppStore()

onMounted(() => {
  appStore.fetchHealth()
})
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <Navbar />
    <main class="flex-1 px-4 py-6 mx-auto w-full">
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
</template>
