<script setup lang="ts">
import type { ReplayRecord } from '@/types/api'
import ReplayStatusBadge from './ReplayStatusBadge.vue'

defineProps<{
  record: ReplayRecord
}>()

const emit = defineEmits<{
  close: []
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

function displaySize(bytes: number | null | undefined) {
  if (!bytes) return '-'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function parseJsonField(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
</script>

<template>
  <div
    class="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
    @click.self="emit('close')"
  >
    <div
      class="bg-white rounded-xl shadow-lg p-6 max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto"
    >
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-semibold text-gray-900">回放详情 #{{ record.id }}</h3>
        <button class="text-gray-400 hover:text-gray-600 text-xl" @click="emit('close')">×</button>
      </div>
      <dl class="space-y-2 text-sm">
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">主播</dt>
          <dd class="text-gray-900">{{ record.principal_name }} ({{ record.principal_id }})</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">回放 ID</dt>
          <dd class="text-gray-900 break-all">{{ record.replay_id || '-' }}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">状态</dt>
          <dd><ReplayStatusBadge :status="record.status" /></dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">时间</dt>
          <dd class="text-gray-900">{{ $formatTime(record.start_time) }}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">时长</dt>
          <dd class="text-gray-900">{{ displayDuration(record.duration) }}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">大小</dt>
          <dd class="text-gray-900">{{ displaySize(record.file_size) }}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">播放页</dt>
          <dd class="text-gray-900 break-all">
            <a
              v-if="record.play_url"
              :href="record.play_url"
              target="_blank"
              class="text-blue-500 hover:text-blue-700"
            >
              {{ record.play_url }}
            </a>
            <span v-else>-</span>
          </dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">m3u8</dt>
          <dd class="text-gray-900 break-all">{{ record.m3u8_url || '-' }}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">原始文件</dt>
          <dd class="text-gray-900 break-all">{{ record.raw_file_path || '-' }}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">最终文件</dt>
          <dd class="text-gray-900 break-all">
            <template v-if="parseJsonField(record.final_file_paths).length > 0">
              <div
                v-for="(f, i) in parseJsonField(record.final_file_paths)"
                :key="i"
                class="text-xs"
              >
                {{ f }}
              </div>
            </template>
            <template v-else>-</template>
          </dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">BV 号</dt>
          <dd class="text-gray-900">{{ record.bv_id || '-' }}</dd>
        </div>
        <div v-if="record.error_message" class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">错误</dt>
          <dd class="text-red-600 break-all">{{ record.error_message }}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">创建时间</dt>
          <dd class="text-gray-900">{{ $formatTime(record.created_at) }}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="text-gray-500 w-28 shrink-0">更新时间</dt>
          <dd class="text-gray-900">{{ $formatTime(record.updated_at) }}</dd>
        </div>
      </dl>
    </div>
  </div>
</template>
