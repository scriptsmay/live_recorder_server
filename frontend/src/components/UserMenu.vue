<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()
const detailsEl = ref<HTMLDetailsElement | null>(null)

function closeDropdown() {
  if (detailsEl.value) {
    detailsEl.value.open = false
  }
}

async function goChangePassword() {
  closeDropdown()
  await router.push('/change-password')
}

async function logout() {
  closeDropdown()
  await auth.logout()
  await router.push('/login')
}
</script>

<template>
  <details v-if="auth.user" ref="detailsEl" class="relative">
    <summary
      class="list-none cursor-pointer rounded px-3 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-700 hover:text-white"
    >
      {{ auth.user.username }}
    </summary>
    <div
      class="absolute left-0 bottom-full mb-2 w-40 rounded-lg border border-gray-700 bg-gray-800 py-2 shadow-xl"
    >
      <div class="px-4 py-2 text-xs text-gray-400">
        <span>当前：</span><span class="text-white bold">{{ auth.user.username }}</span>
      </div>
      <button
        type="button"
        class="block w-full px-4 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-gray-700 hover:text-white"
        @click="goChangePassword"
      >
        修改密码
      </button>
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
