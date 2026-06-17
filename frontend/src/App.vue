<script setup lang="ts">
import { computed } from 'vue'
import { RouterView } from 'vue-router'
import { useRoute } from 'vue-router'
import Layout from '@/components/Layout.vue'
import ToastContainer from '@/components/ToastContainer.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const isPublicRoute = computed(() => route.meta.public === true)
</script>

<template>
  <div v-if="!auth.ready" class="min-h-screen flex items-center justify-center bg-surface">
    <div class="flex flex-col items-center gap-3 text-gray-500">
      <div
        class="h-10 w-10 rounded-full border-4 border-brand-500 border-t-transparent animate-spin"
      />
      <div class="text-sm">正在恢复登录态...</div>
    </div>
  </div>
  <RouterView v-else-if="isPublicRoute" />
  <Layout v-else>
    <RouterView />
  </Layout>
  <ToastContainer />
  <ConfirmDialog />
</template>
