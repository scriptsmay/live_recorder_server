<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

async function logout() {
  await auth.logout()
  await router.push('/login')
}
</script>

<template>
  <details v-if="auth.user" class="relative">
    <summary
      class="list-none cursor-pointer rounded px-3 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-700 hover:text-white"
    >
      {{ auth.user.username }}
    </summary>
    <div
      class="absolute right-0 top-full mt-2 w-40 rounded-lg border border-gray-700 bg-gray-800 py-2 shadow-xl"
    >
      <div class="px-4 py-2 text-xs text-gray-400">当前用户</div>
      <div class="px-4 pb-2 text-sm text-white truncate">{{ auth.user.username }}</div>
      <button
        type="button"
        class="block w-full px-4 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-gray-700 hover:text-white"
        @click="logout"
      >
        退出登录
      </button>
    </div>
  </details>
</template>
