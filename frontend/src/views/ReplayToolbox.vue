<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useReplayToolboxStore } from '@/stores/replay-toolbox'
import PrincipalCard from '@/components/replay/PrincipalCard.vue'

const store = useReplayToolboxStore()

let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await Promise.all([store.fetchPrincipals(), store.fetchTaskStatus()])
  pollTimer = setInterval(() => store.fetchTaskStatus(), 15000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div>
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">回放工具箱</h1>
        <p class="text-sm text-gray-500 mt-1">快手回放拉取、处理队列、投稿与备份管理</p>
      </div>
      <button
        class="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
        @click="store.fetchPrincipals()"
      >
        刷新
      </button>
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
      <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div class="text-xs text-gray-500">主播数</div>
        <div class="text-2xl font-semibold text-gray-900 mt-1">{{ store.principals.length }}</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div class="text-xs text-gray-500">队列等待</div>
        <div class="text-2xl font-semibold text-gray-900 mt-1">
          {{ store.taskStatus?.queue_length ?? 0 }}
        </div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div class="text-xs text-gray-500">处理中 / 并发</div>
        <div class="text-2xl font-semibold text-gray-900 mt-1">
          {{ store.taskStatus?.processing ?? 0 }} / {{ store.taskStatus?.concurrency ?? 1 }}
        </div>
      </div>
    </div>

    <div v-if="store.loadingPrincipals" class="text-center py-12 text-sm text-gray-400">
      加载中...
    </div>
    <div v-else-if="store.principals.length === 0" class="text-center py-12 text-sm text-gray-400">
      暂无快手直播间，请先在"直播间"中添加快手房间
    </div>
    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      <PrincipalCard
        v-for="principal in store.principals"
        :key="principal.principal_id"
        :principal="principal"
      />
    </div>
  </div>
</template>
