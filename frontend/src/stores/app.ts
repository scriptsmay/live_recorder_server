import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 全局应用状态
 * 存放跨页面共享的状态，如应用版本、健康状态等
 */
export const useAppStore = defineStore('app', () => {
  const appVersion = ref('')
  const dockerImageVersion = ref('')
  const serverStartTime = ref('')
  const isHealthy = ref(true)
  const dbHealthy = ref<boolean | null>(null)
  const redisHealthy = ref<boolean | null>(null)
  const healthLoaded = ref(false)
  const sidebarCollapsed = ref(false)

  async function fetchHealth() {
    try {
      const res = await fetch('/api/health')
      const data = await res.json()
      appVersion.value = data.version ?? ''
      dockerImageVersion.value = data.docker_image_version ?? ''
      serverStartTime.value = data.server_start_time ?? ''
      isHealthy.value = data.ok === true
      dbHealthy.value = data.db === true
      redisHealthy.value = data.redis === true
    } catch {
      isHealthy.value = false
      dbHealthy.value = false
      redisHealthy.value = false
    } finally {
      healthLoaded.value = true
    }
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  return {
    appVersion,
    dockerImageVersion,
    serverStartTime,
    isHealthy,
    dbHealthy,
    redisHealthy,
    healthLoaded,
    sidebarCollapsed,
    fetchHealth,
    toggleSidebar,
  }
})
