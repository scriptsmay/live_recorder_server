<script setup lang="ts">
import type { ReplayRecordStatus } from '@/types/api'

const props = defineProps<{
  status: ReplayRecordStatus | string | null
}>()

const statusLabels: Record<string, string> = {
  pending: '待处理',
  extracted: '已提取',
  downloaded: '已下载',
  cut: '已剪切',
  fixed: '已修复',
  uploaded: '已投稿',
  completed: '已完成',
  backed_up: '已备份',
  failed: '失败',
}

const statusClasses: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  extracted: 'bg-sky-100 text-sky-700',
  downloaded: 'bg-indigo-100 text-indigo-700',
  cut: 'bg-violet-100 text-violet-700',
  fixed: 'bg-emerald-100 text-emerald-700',
  uploaded: 'bg-green-100 text-green-700',
  completed: 'bg-teal-100 text-teal-700',
  backed_up: 'bg-teal-100 text-teal-700',
  failed: 'bg-red-100 text-red-700',
}

const label = statusLabels[props.status || 'pending'] ?? props.status ?? '-'
const cls = statusClasses[props.status || 'pending'] ?? 'bg-gray-100 text-gray-700'
</script>

<template>
  <span class="inline-flex px-2 py-0.5 text-xs font-medium rounded-full" :class="cls">
    {{ label }}
  </span>
</template>
