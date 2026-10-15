import { ref } from 'vue'

/**
 * 路由切换顶部进度条状态（模块级单例）
 *
 * 由 router 守卫驱动：beforeEach -> startProgress()，afterEach/onError -> finishProgress()
 * 组件 RouteProgress.vue 读取 active / progress 渲染顶部细进度条。
 *
 * 采用「延迟显示 + 缓慢爬升」策略：
 *  - 120ms 内完成的导航不显示进度条，避免本地缓存页切换时闪烁；
 *  - 显示后进度缓慢趋近 90%，导航完成后瞬间补满并淡出。
 */

const active = ref(false)
const progress = ref(0)

let showTimer: ReturnType<typeof setTimeout> | null = null
let trickleTimer: ReturnType<typeof setInterval> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

function clearTimers() {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = null
  }
  if (trickleTimer) {
    clearInterval(trickleTimer)
    trickleTimer = null
  }
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

export function startProgress() {
  clearTimers()
  progress.value = 0

  showTimer = setTimeout(() => {
    active.value = true
    progress.value = 12
    trickleTimer = setInterval(() => {
      progress.value = Math.min(90, progress.value + Math.max((90 - progress.value) * 0.15, 0.8))
    }, 180)
  }, 120)
}

export function finishProgress() {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = null
  }
  if (trickleTimer) {
    clearInterval(trickleTimer)
    trickleTimer = null
  }

  if (!active.value) {
    progress.value = 0
    return
  }

  progress.value = 100
  hideTimer = setTimeout(() => {
    active.value = false
    progress.value = 0
  }, 220)
}

export function useRouteProgress() {
  return { active, progress }
}
