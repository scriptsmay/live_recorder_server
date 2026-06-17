<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError } from '@/utils/api'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const username = ref('admin')
const password = ref('')
const loading = ref(false)
const error = ref('')

const redirectTo = computed(() => {
  const redirect = route.query.redirect
  return typeof redirect === 'string' && redirect.startsWith('/') ? redirect : '/dashboard'
})

async function submit() {
  error.value = ''
  loading.value = true
  try {
    await auth.login(username.value, password.value)
    await router.replace(redirectTo.value)
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 429) {
      error.value = '登录失败次数过多，请稍后再试'
    } else if (err instanceof ApiError && err.statusCode === 401) {
      error.value = '用户名或密码不正确'
    } else {
      error.value = err instanceof Error ? err.message : '登录失败'
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-surface flex items-center justify-center px-4 py-12">
    <form
      class="w-full max-w-sm bg-white border border-gray-200 rounded-lg shadow-sm p-6"
      @submit.prevent="submit"
    >
      <div class="flex items-center gap-3 mb-6">
        <img src="/logo.svg" alt="K-Recorder" class="h-9 w-9" />
        <div>
          <h1 class="text-xl font-semibold text-gray-900">K-Recorder</h1>
          <p class="text-sm text-gray-500">管理员登录</p>
        </div>
      </div>

      <div
        v-if="error"
        class="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
      >
        {{ error }}
      </div>

      <label class="block text-sm font-medium text-gray-700 mb-1" for="username">用户名</label>
      <input
        id="username"
        v-model.trim="username"
        class="mb-4 w-full rounded border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        autocomplete="username"
        required
      />

      <label class="block text-sm font-medium text-gray-700 mb-1" for="password">密码</label>
      <input
        id="password"
        v-model="password"
        class="mb-5 w-full rounded border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        type="password"
        autocomplete="current-password"
        required
        autofocus
      />

      <button
        type="submit"
        class="w-full rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="loading"
      >
        {{ loading ? '登录中...' : '登录' }}
      </button>
    </form>
  </div>
</template>
