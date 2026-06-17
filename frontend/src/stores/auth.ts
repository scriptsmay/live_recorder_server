import { defineStore } from 'pinia'
import { ref } from 'vue'
import { apiGet, apiPost } from '@/utils/api'

interface User {
  username: string
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const ready = ref(false)

  async function fetchMe() {
    try {
      const res = await apiGet<User>('/api/auth/me')
      user.value = res.data
    } catch {
      user.value = null
    } finally {
      ready.value = true
    }
  }

  async function login(username: string, password: string) {
    const res = await apiPost<User>('/api/auth/login', { username, password })
    user.value = res.data
    ready.value = true
    return res.data
  }

  async function logout() {
    try {
      await apiPost('/api/auth/logout')
    } catch {
      /* local cleanup still needs to happen */
    }
    user.value = null
    ready.value = true
  }

  function clearLocal() {
    user.value = null
    ready.value = true
  }

  return {
    user,
    ready,
    fetchMe,
    login,
    logout,
    clearLocal,
  }
})
