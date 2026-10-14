import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'theme'

function initialTheme(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return 'light'
}

/**
 * 主题状态（亮色 / 深色），持久化到 localStorage 并写入 <html data-theme>。
 * 具体配色由 src/style.css 中的 token 覆盖实现。
 */
export const useThemeStore = defineStore('theme', () => {
  const theme = ref<ThemeMode>(initialTheme())

  function apply() {
    document.documentElement.dataset.theme = theme.value
  }

  function setTheme(next: ThemeMode) {
    theme.value = next
    localStorage.setItem(STORAGE_KEY, next)
    apply()
  }

  function toggle() {
    setTheme(theme.value === 'dark' ? 'light' : 'dark')
  }

  function init() {
    apply()
  }

  return { theme, setTheme, toggle, init }
})
