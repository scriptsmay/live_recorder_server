<script setup lang="ts">
import type { ReplayPrincipal } from '@/types/api'
import ReplayStatusBadge from './ReplayStatusBadge.vue'

defineProps<{
  principal: ReplayPrincipal
}>()

function displayTime(value: string | null | undefined) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
</script>

<template>
  <router-link
    :to="`/replay-toolbox/${principal.principal_id}`"
    class="block bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md hover:border-brand-300 transition-all cursor-pointer"
  >
    <div class="flex items-center gap-3 mb-3">
      <div
        class="w-10 h-10 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-sm font-semibold shrink-0"
      >
        {{ (principal.room_name || principal.principal_id).charAt(0) }}
      </div>
      <div class="min-w-0">
        <div class="text-sm font-semibold text-gray-900 truncate">
          {{ principal.room_name || principal.principal_id }}
        </div>
        <div class="text-xs text-gray-400 truncate">{{ principal.principal_id }}</div>
      </div>
    </div>
    <div class="flex items-center justify-between text-xs text-gray-500">
      <span>{{ principal.replay_count }} 条回放</span>
      <ReplayStatusBadge v-if="principal.latest_status" :status="principal.latest_status" />
    </div>
    <div class="text-xs text-gray-400 mt-1">
      最近: {{ displayTime(principal.latest_replay_time) }}
    </div>
  </router-link>
</template>
