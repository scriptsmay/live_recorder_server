<script setup lang="ts">
import type { ReplayRecord } from '@/types/api'
import ReplayStatusBadge from './ReplayStatusBadge.vue'
import ReplayActionButton from './ReplayActionButton.vue'

defineProps<{
  records: ReplayRecord[]
  loading: boolean
  page: number
  totalPages: number
  total: number
  busy?: boolean
}>()

const emit = defineEmits<{
  showDetail: [record: ReplayRecord]
  action: [recordId: number, action: string]
  pageChange: [delta: number]
}>()

function displayDuration(seconds: number | null | undefined) {
  if (!seconds) return '-'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
  }
  return `${minutes}m ${rest}s`
}
</script>

<template>
  <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
    <div class="px-4 py-3 border-b border-gray-100">
      <h2 class="text-sm font-semibold text-gray-900">回放记录</h2>
    </div>

    <div class="overflow-x-auto">
      <table class="min-w-full divide-y divide-gray-100">
        <thead class="bg-gray-50">
          <tr>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">时间</th>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">回放</th>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">状态</th>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">时长</th>
            <th class="px-4 py-2 text-right text-xs font-medium text-gray-500">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 bg-white">
          <tr v-if="loading">
            <td colspan="5" class="px-4 py-10 text-center text-sm text-gray-400">加载中...</td>
          </tr>
          <tr v-else-if="records.length === 0">
            <td colspan="5" class="px-4 py-10 text-center text-sm text-gray-400">暂无回放记录</td>
          </tr>
          <tr v-for="record in records" v-else :key="record.id" class="hover:bg-gray-50">
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
              {{ $formatTime(record.start_time) }}
            </td>
            <td class="px-4 py-3 cursor-pointer" @click="emit('showDetail', record)">
              <div
                class="text-sm font-medium text-gray-900 truncate max-w-[260px] hover:text-brand-600"
              >
                {{ record.video_file_name || record.replay_id || `#${record.id}` }}
              </div>
            </td>
            <td class="px-4 py-3 whitespace-nowrap">
              <ReplayStatusBadge :status="record.status" />
            </td>
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
              {{ displayDuration(record.duration) }}
            </td>
            <td class="px-4 py-3 text-right">
              <ReplayActionButton
                :record-id="record.id"
                :busy="busy"
                @action="(id, a) => emit('action', id, a)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      class="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-sm text-gray-500"
    >
      <span>第 {{ page }} / {{ totalPages }} 页，共 {{ total }} 条</span>
      <div class="flex items-center gap-2">
        <button
          class="px-3 py-1 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
          :disabled="page <= 1"
          @click="emit('pageChange', -1)"
        >
          上一页
        </button>
        <button
          class="px-3 py-1 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
          :disabled="page >= totalPages"
          @click="emit('pageChange', 1)"
        >
          下一页
        </button>
      </div>
    </div>
  </div>
</template>
