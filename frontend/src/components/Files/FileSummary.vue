<script setup lang="ts">
import { computed } from 'vue'
import { useFileStore } from '@/stores/file-manage'

const fileStore = useFileStore()

const summary = computed(() => fileStore.summary)

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i]
}

const categoryLabels: Record<string, string> = {
  recording: '直播录制',
  replay: '回放文件',
  danmaku: '弹幕压制',
  orphan: '孤儿文件',
}

const categoryColors: Record<string, string> = {
  recording: 'bg-blue-50 border-blue-200 text-blue-800',
  replay: 'bg-purple-50 border-purple-200 text-purple-800',
  danmaku: 'bg-amber-50 border-amber-200 text-amber-800',
  orphan: 'bg-gray-50 border-gray-200 text-gray-800',
}
</script>

<template>
  <div v-if="fileStore.summaryLoading" class="text-center py-8 text-gray-500">加载中...</div>
  <div v-else-if="summary" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
    <!-- 各目录卡片 -->
    <div
      v-for="group in summary.groups"
      :key="group.type"
      class="rounded-xl border p-4"
      :class="categoryColors[group.type] || 'bg-gray-50 border-gray-200'"
    >
      <div class="text-sm font-medium opacity-75">
        {{ categoryLabels[group.type] || group.type }}
      </div>
      <div class="text-2xl font-bold mt-1">{{ formatBytes(group.size) }}</div>
      <div class="text-xs mt-1 opacity-60">{{ group.file_count }} 个文件</div>
      <div v-if="group.root" class="text-xs mt-1 opacity-40 truncate" :title="group.root">
        {{ group.root }}
      </div>
    </div>
    <!-- 总计卡片 -->
    <div class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div class="text-sm font-medium text-gray-500">总计</div>
      <div class="text-2xl font-bold text-gray-900 mt-1">{{ formatBytes(summary.total_size) }}</div>
      <div class="text-xs mt-1 text-green-600">
        可清理: {{ formatBytes(summary.safe_to_delete_size) }}
      </div>
    </div>
  </div>
</template>
