<script setup lang="ts">
import { computed, watch } from 'vue'
import { useFileStore } from '@/stores/file-manage'
import { formatBytes, formatTime } from '@/utils/lib'
import type { ManagedFile, FileType } from '@/types/file-manage'

const props = defineProps<{
  visible: boolean
  fileId: number | null
}>()

const emit = defineEmits<{
  close: []
  'delete-single': [file: ManagedFile]
}>()

const fileStore = useFileStore()
const detail = computed(() => fileStore.fileDetail)

watch(
  () => [props.fileId, props.visible] as const,
  ([id, v]) => {
    if (v && id !== null) {
      fileStore.fetchFileDetail(id)
    }
  },
)

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

const activeTaskLabels: Record<string, string> = {
  recording: '录制中',
  transcoding: '转码中',
  uploading: '投稿中',
}

function handleDelete() {
  if (detail.value) {
    emit('delete-single', detail.value)
  }
}
</script>

<template>
  <!-- 遮罩 -->
  <Transition name="fade">
    <div v-if="visible" class="fixed inset-0 bg-black/30 z-40" @click="emit('close')" />
  </Transition>

  <!-- 抽屉 -->
  <Transition name="slide-right">
    <div
      v-if="visible"
      class="fixed top-0 right-0 h-full w-full max-w-lg bg-white shadow-2xl z-50 flex flex-col"
    >
      <!-- 头部 -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
        <h2 class="text-lg font-bold text-gray-900">文件详情</h2>
        <button
          class="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
          @click="emit('close')"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      <!-- 内容 -->
      <div class="flex-1 overflow-y-auto px-6 py-4">
        <div v-if="fileStore.fileDetailLoading" class="text-center py-12 text-gray-500">
          加载中...
        </div>
        <div v-else-if="detail" class="space-y-4">
          <!-- 基本信息 -->
          <div class="space-y-2">
            <div class="text-sm text-gray-500">文件名</div>
            <div class="font-medium break-all">{{ detail.file_name || '-' }}</div>
          </div>

          <div class="space-y-2">
            <div class="text-sm text-gray-500">完整路径</div>
            <div class="text-xs font-mono bg-gray-50 rounded p-2 break-all text-gray-700">
              {{ detail.file_path }}
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div>
              <div class="text-sm text-gray-500 mb-1">文件类型</div>
              <span class="inline-block px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                {{ fileTypeLabels[detail.file_type] || detail.file_type }}
              </span>
            </div>
            <div>
              <div class="text-sm text-gray-500 mb-1">分类</div>
              <span class="text-sm">{{ detail.category }}</span>
            </div>
            <div>
              <div class="text-sm text-gray-500 mb-1">文件大小</div>
              <span class="text-sm font-medium">{{ formatBytes(detail.file_size) }}</span>
            </div>
            <div>
              <div class="text-sm text-gray-500 mb-1">扩展名</div>
              <span class="text-sm">{{ detail.extension || '-' }}</span>
            </div>
            <div>
              <div class="text-sm text-gray-500 mb-1">最近修改</div>
              <span class="text-sm">{{ formatTime(detail.mtime) }}</span>
            </div>
            <div>
              <div class="text-sm text-gray-500 mb-1">创建时间</div>
              <span class="text-sm">{{ formatTime(detail.created_at) }}</span>
            </div>
          </div>

          <!-- 状态 -->
          <div class="border-t border-gray-100 pt-4">
            <div class="text-sm font-medium text-gray-700 mb-2">状态信息</div>
            <div class="grid grid-cols-2 gap-3">
              <div class="flex items-center gap-2">
                <span
                  class="w-3 h-3 rounded-full"
                  :class="detail.exists_on_disk ? 'bg-green-500' : 'bg-red-500'"
                />
                <span class="text-sm">{{ detail.exists_on_disk ? '磁盘存在' : '磁盘不存在' }}</span>
              </div>
              <div class="flex items-center gap-2">
                <span
                  class="w-3 h-3 rounded-full"
                  :class="detail.status === 'active' ? 'bg-green-500' : 'bg-yellow-500'"
                />
                <span class="text-sm">状态: {{ detail.status }}</span>
              </div>
              <div class="flex items-center gap-2">
                <span
                  class="w-3 h-3 rounded-full"
                  :class="detail.safe_to_delete ? 'bg-green-500' : 'bg-gray-400'"
                />
                <span class="text-sm">{{
                  detail.safe_to_delete ? '可安全删除' : detail.delete_block_reason || '不可删除'
                }}</span>
              </div>
              <div v-if="detail.active_task" class="flex items-center gap-2">
                <span class="w-3 h-3 rounded-full bg-orange-500 animate-pulse" />
                <span class="text-sm text-orange-700">
                  {{ activeTaskLabels[detail.active_task.type] || detail.active_task.type }}
                </span>
              </div>
            </div>
          </div>

          <!-- 来源 -->
          <div class="border-t border-gray-100 pt-4">
            <div class="text-sm font-medium text-gray-700 mb-2">来源信息</div>
            <div class="text-sm text-gray-600">
              来源表: {{ detail.source_table || '-' }}<br />
              来源 ID: {{ detail.source_id || '-' }}<br />
              聚合 ID: {{ detail.group_id || '-' }}
            </div>
          </div>

          <!-- 审计日志 -->
          <div v-if="detail.recent_audits?.length" class="border-t border-gray-100 pt-4">
            <div class="text-sm font-medium text-gray-700 mb-2">最近操作</div>
            <div class="space-y-2">
              <div
                v-for="audit in detail.recent_audits"
                :key="audit.id"
                class="text-xs bg-gray-50 rounded p-2"
              >
                <span class="font-medium">{{ audit.action }}</span>
                <span class="mx-1">→</span>
                <span :class="audit.result === 'success' ? 'text-green-600' : 'text-red-600'">{{
                  audit.result
                }}</span>
                <span class="text-gray-400 ml-2">{{ formatTime(audit.created_at) }}</span>
                <div v-if="audit.error_message" class="text-red-500 mt-1">
                  {{ audit.error_message }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部操作 -->
      <div class="border-t border-gray-200 px-6 py-4 shrink-0">
        <button
          v-if="detail?.safe_to_delete"
          class="w-full px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors text-sm font-medium"
          @click="handleDelete"
        >
          删除此文件
        </button>
        <div v-else class="text-sm text-gray-500 text-center">
          {{ detail?.delete_block_reason || '此文件当前不可删除' }}
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.slide-right-enter-active {
  transition: transform 0.3s ease;
}
.slide-right-leave-active {
  transition: transform 0.2s ease;
}
.slide-right-enter-from,
.slide-right-leave-to {
  transform: translateX(100%);
}
</style>
