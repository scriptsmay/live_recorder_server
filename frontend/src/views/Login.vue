<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError } from '@/utils/api'
import { useAuthStore } from '@/stores/auth'
import ThemeToggle from '@/components/ThemeToggle.vue'

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
  <div class="relative min-h-screen flex items-center justify-center px-4 py-12 overflow-hidden">
    <!-- 右上角主题切换 -->
    <div class="absolute top-4 right-4 z-10">
      <ThemeToggle />
    </div>

    <!-- 环境光斑 -->
    <div
      class="pointer-events-none absolute -top-40 left-1/2 h-[28rem] w-[28rem] -translate-x-1/2 rounded-full bg-brand-500/20 blur-[130px]"
      aria-hidden="true"
    />
    <div
      class="pointer-events-none absolute bottom-0 right-1/4 h-72 w-72 rounded-full bg-purple-500/10 blur-[120px]"
      aria-hidden="true"
    />

    <form
      class="relative w-full max-w-sm glass-panel rounded-2xl p-7 shadow-2xl shadow-black/60 shimmer-sweep"
      @submit.prevent="submit"
    >
      <div class="mb-7 flex items-center gap-3">
        <div
          class="flex h-11 w-11 items-center justify-center rounded-xl border border-gray-200 bg-white"
        >
          <img src="/logo.svg" alt="K-Recorder" class="h-7 w-7" />
        </div>
        <div>
          <h1 class="text-xl font-semibold text-gray-900">K-Recorder</h1>
          <p class="text-sm text-gray-500">管理员登录</p>
        </div>
      </div>

      <div
        v-if="error"
        class="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
      >
        {{ error }}
      </div>

      <label class="mb-1.5 block text-xs font-medium text-gray-700" for="username">用户名</label>
      <input
        id="username"
        v-model.trim="username"
        class="mb-4 w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
        autocomplete="username"
        required
      />

      <label class="mb-1.5 block text-xs font-medium text-gray-700" for="password">密码</label>
      <input
        id="password"
        v-model="password"
        class="mb-6 w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-900 outline-none transition focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-100"
        type="password"
        autocomplete="current-password"
        required
        autofocus
      />

      <button
        type="submit"
        class="glow-accent w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="loading"
      >
        {{ loading ? '登录中…' : '登录' }}
      </button>
    </form>
  </div>
</template>
