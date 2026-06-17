<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useReplayToolboxStore } from '@/stores/replay-toolbox'

const store = useReplayToolboxStore()

let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await store.fetchTaskStatus()
  pollTimer = setInterval(() => store.fetchTaskStatus(), 10000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div class="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <div class="text-xs text-gray-500 mb-1">队列等待</div>
        <div class="text-3xl font-semibold text-gray-900">
          {{ store.taskStatus?.queue_length ?? 0 }}
        </div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <div class="text-xs text-gray-500 mb-1">处理中</div>
        <div class="text-3xl font-semibold text-gray-900">
          {{ store.taskStatus?.processing ?? 0 }}
        </div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <div class="text-xs text-gray-500 mb-1">并发上限</div>
        <div class="text-3xl font-semibold text-gray-900">
          {{ store.taskStatus?.concurrency ?? 1 }}
        </div>
      </div>
    </div>

    <div class="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <h2 class="text-sm font-semibold text-gray-900 mb-3">队列说明</h2>
      <ul class="text-sm text-gray-600 space-y-2">
        <li>• 回放处理队列默认单并发运行，适合小内存 NAS 资源限制</li>
        <li>• 每个任务依次执行：提取 m3u8 → 下载 → 切片 → 修复 → 投稿 → 备份</li>
        <li>• 单任务失败不会阻塞队列，失败原因记录在回放记录的错误信息中</li>
        <li>• 可在回放记录页面对单条记录重新触发任意阶段</li>
      </ul>
    </div>
  </div>
</template>
