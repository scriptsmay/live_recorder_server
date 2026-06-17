<script setup lang="ts">
import type { ReplayUploadRecord } from '@/types/api'

defineProps<{
  uploads: ReplayUploadRecord[]
  loading: boolean
}>()
</script>

<template>
  <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
    <div class="px-4 py-3 border-b border-gray-100">
      <h2 class="text-sm font-semibold text-gray-900">投稿记录</h2>
    </div>
    <div class="overflow-x-auto">
      <table class="min-w-full divide-y divide-gray-100">
        <thead class="bg-gray-50">
          <tr>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">时间</th>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">标题</th>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">状态</th>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">BV</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-if="loading">
            <td colspan="4" class="px-4 py-8 text-center text-sm text-gray-400">加载中...</td>
          </tr>
          <tr v-else-if="uploads.length === 0">
            <td colspan="4" class="px-4 py-8 text-center text-sm text-gray-400">暂无投稿记录</td>
          </tr>
          <tr v-for="upload in uploads" v-else :key="upload.id">
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
              {{ $formatTime(upload.created_at) }}
            </td>
            <td class="px-4 py-3 text-sm text-gray-900 max-w-[420px] truncate">
              {{ upload.title || `回放 #${upload.replay_record_id}` }}
            </td>
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
              {{ upload.status }}
            </td>
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
              {{ upload.bv_id || '-' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
