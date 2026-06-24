<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()
const open = ref(false)

function toggle() {
  open.value = !open.value
}

function close() {
  open.value = false
}

async function goChangePassword() {
  close()
  await router.push('/change-password')
}

async function logout() {
  close()
  await auth.logout()
  await router.push('/login')
}
</script>

<template>
  <div v-if="auth.user" class="relative">
    <button
      type="button"
      class="cursor-pointer rounded px-3 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-700 hover:text-white"
      @click="toggle"
    >
      {{ auth.user.username }}
    </button>
    <Transition name="menu">
      <div
        v-if="open"
        class="absolute left-0 bottom-full mb-2 w-44 rounded-lg border border-gray-700 bg-gray-800 py-2 shadow-xl"
      >
        <div class="px-4 py-2 text-xs text-gray-400">
          当前：<span class="text-white font-medium">{{ auth.user.username }}</span>
        </div>
        <div class="border-t border-gray-700 my-1" />
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
    </Transition>
  </div>
</template>

<style scoped>
.menu-enter-active,
.menu-leave-active {
  transition:
    opacity 0.1s ease,
    transform 0.1s ease;
}
.menu-enter-from,
.menu-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
