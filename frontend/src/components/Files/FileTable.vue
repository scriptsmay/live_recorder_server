<script setup lang="ts">
import { computed } from 'vue'
import type { ManagedFile, FileType } from '@/types/file-manage'

const props = defineProps<{
  files: ManagedFile[]
  loading: boolean
  selectedIds: Set<number>
}>()

const emit = defineEmits<{
  'update:selectedIds': [ids: Set<number>]
  'row-click': [file: ManagedFile]
  'delete-single': [file: ManagedFile]
  'page-change': [page: number]
}>()

defineExpose({
  formatBytes,
})

const total = defineModel<number>('total', { default: 0 })
const page = defineModel<number>('page', { default: 1 })
const limit = defineModel<number>('limit', { default: 50 })

const totalPages = computed(() => Math.ceil(total.value / limit.value))

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i]
}

function formatTime(t: string | null): string {
  if (!t) return '-'
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

const fileTypeLabels: Record<FileType, string> = {
  recording_file: '录制文件',
  hls_directory: 'HLS 目录',
  replay_raw: '回放原始',
  replay_cut: '回放切片',
  replay_fixed: '回放修复',
  replay_final: '回放成品',
  danmaku_output: '弹幕压制',
  danmaku_archive: '弹幕归档',
  danmaku_ass_cache: 'ASS 缓存',
  orphan: '孤儿文件',
}

const statusStyles: Record<string, string> = {
  active: 'text-green-700 bg-green-50',
  missing: 'text-red-700 bg-red-50',
  deleting: 'text-yellow-700 bg-yellow-50',
  deleted: 'text-gray-500 bg-gray-100',
}

function toggleSelect(id: number) {
  const next = new Set(props.selectedIds)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  emit('update:selectedIds', next)
}

function toggleSelectAll() {
  if (props.selectedIds.size === props.files.length) {
    emit('update:selectedIds', new Set())
  } else {
    emit('update:selectedIds', new Set(props.files.map((f) => f.id)))
  }
}

const allSelected = computed(
  () => props.files.length > 0 && props.selectedIds.size === props.files.length,
)

function handleDeleteSingle(e: MouseEvent, file: ManagedFile) {
  e.stopPropagation()
  emit('delete-single', file)
}
</script>

<template>
  <!-- Loading -->
  <div v-if="loading" class="text-center py-12 text-gray-500">
    <svg class="animate-spin h-6 w-6 mx-auto mb-2 text-gray-400" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
    加载中...
  </div>

  <!-- Empty -->
  <div v-else-if="files.length === 0" class="text-center py-12 text-gray-400">
    <svg class="w-12 h-12 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.5"
        d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
      />
    </svg>
    暂无文件
  </div>

  <!-- Table -->
  <div v-else class="overflow-x-auto">
    <table class="min-w-full text-sm">
      <thead>
        <tr
          class="border-b border-gray-200 text-left text-gray-500 text-xs uppercase tracking-wider"
        >
          <th class="px-3 py-3 w-10">
            <input
              type="checkbox"
              :checked="allSelected"
              class="rounded"
              @change="toggleSelectAll"
            />
          </th>
          <th class="px-3 py-3">文件名</th>
          <th class="px-3 py-3">类型</th>
          <th class="px-3 py-3 text-right">大小</th>
          <th class="px-3 py-3">状态</th>
          <th class="px-3 py-3">可删除</th>
          <th class="px-3 py-3">最近修改</th>
          <th class="px-3 py-3 w-20">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="file in files"
          :key="file.id"
          class="border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors"
          @click="emit('row-click', file)"
        >
          <td class="px-3 py-3" @click.stop>
            <input
              type="checkbox"
              :checked="selectedIds.has(file.id)"
              class="rounded"
              @change="toggleSelect(file.id)"
            />
          </td>
          <td class="px-3 py-3 max-w-xs">
            <div class="font-medium text-gray-900 truncate" :title="file.file_name || ''">
              {{ file.file_name || '-' }}
            </div>
            <div class="text-xs text-gray-400 truncate" :title="file.file_path">
              {{ file.file_path }}
            </div>
          </td>
          <td class="px-3 py-3">
            <span class="inline-block px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
              {{ fileTypeLabels[file.file_type] || file.file_type }}
            </span>
          </td>
          <td class="px-3 py-3 text-right text-gray-700 font-mono text-xs">
            {{ formatBytes(file.file_size) }}
          </td>
          <td class="px-3 py-3">
            <span
              class="inline-block px-2 py-0.5 rounded text-xs"
              :class="statusStyles[file.status] || 'text-gray-600 bg-gray-100'"
            >
              {{ file.status }}
            </span>
          </td>
          <td class="px-3 py-3">
            <span v-if="file.safe_to_delete" class="text-green-600 text-xs">✓ 可删除</span>
            <span v-else class="text-gray-400 text-xs" :title="file.delete_block_reason || ''">
              {{ file.delete_block_reason || '不可删除' }}
            </span>
          </td>
          <td class="px-3 py-3 text-xs text-gray-500">{{ formatTime(file.mtime) }}</td>
          <td class="px-3 py-3" @click.stop>
            <button
              v-if="file.safe_to_delete"
              class="text-red-600 hover:text-red-800 text-xs underline"
              @click="handleDeleteSingle($event, file)"
            >
              删除
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 分页 -->
    <div
      v-if="totalPages > 1"
      class="flex items-center justify-between px-3 py-3 border-t border-gray-100 text-sm text-gray-500"
    >
      <span>共 {{ total }} 个文件，第 {{ page }}/{{ totalPages }} 页</span>
      <div class="flex gap-2">
        <button
          class="px-3 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
          :disabled="page <= 1"
          @click="emit('page-change', page - 1)"
        >
          上一页
        </button>
        <button
          class="px-3 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
          :disabled="page >= totalPages"
          @click="emit('page-change', page + 1)"
        >
          下一页
        </button>
      </div>
    </div>
  </div>
</template>
