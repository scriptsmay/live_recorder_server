<script setup lang="ts">
import { computed } from 'vue'
import { RouterView } from 'vue-router'
import { useRoute } from 'vue-router'
import Layout from '@/components/Layout.vue'
import ToastContainer from '@/components/ToastContainer.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import RouteProgress from '@/components/RouteProgress.vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const isPublicRoute = computed(() => route.meta.public === true)
</script>

<template>
  <RouteProgress />
  <div v-if="!auth.ready" class="min-h-screen flex items-center justify-center">
    <div class="flex flex-col items-center gap-4 text-gray-400">
      <div class="relative h-11 w-11">
        <div class="absolute inset-0 rounded-full border-2 border-gray-200" />
        <div
          class="absolute inset-0 rounded-full border-2 border-transparent border-t-brand-500 animate-spin"
        />
      </div>
      <div class="text-sm tracking-wide">正在恢复登录态…</div>
    </div>
  </div>
  <RouterView v-else-if="isPublicRoute" />
  <Layout v-else>
    <RouterView />
  </Layout>
  <ToastContainer />
  <ConfirmDialog />
</template>
