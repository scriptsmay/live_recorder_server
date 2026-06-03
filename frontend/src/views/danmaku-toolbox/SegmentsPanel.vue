<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  useDanmakuToolboxStore,
  type RecordingFile,
  type BurnRecord,
} from '@/stores/danmaku-toolbox'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'

const props = defineProps<{
  sessionId: number
  loaded: boolean
}>()

const emit = defineEmits<{
  loaded: []
  refresh: []
}>()

const store = useDanmakuToolboxStore()
const toast = useToast()
const { confirm } = useConfirm()

const files = ref<RecordingFile[]>([])
const burnRecords = ref<BurnRecord[]>([])
const loading = ref(false)
const localLoaded = ref(false)

const burnMap = ref<Record<number, BurnRecord>>({})

onMounted(async () => {
  if (props.loaded) {
    localLoaded.value = true
    return
  }
  await loadData()
})

async function loadData() {
  loading.value = true
  try {
    const result = await store.fetchSegments(props.sessionId)
    files.value = result.files
    burnRecords.value = result.burnRecords

    const map: Record<number, BurnRecord> = {}
    for (const br of result.burnRecords) {
      map[br.recording_file_id] = br
    }
    burnMap.value = map

    localLoaded.value = true
    emit('loaded')
  } catch (err) {
    toast.error('加载分段失败: ' + (err instanceof Error ? err.message : '未知错误'))
  } finally {
    loading.value = false
  }
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return '—'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function getFileName(filePath: string | null): string {
  if (!filePath) return '—'
  return filePath.split('/').pop() || '—'
}

function getAssBadge(file: RecordingFile) {
  if (file.danmaku_ass_exists || file.danmaku_ass_path) {
    return { text: '就绪', cls: 'bg-green-100 text-green-700' }
  }
  return { text: '—', cls: 'bg-gray-100 text-gray-500' }
}

function getBurnBadge(fileId: number) {
  const br = burnMap.value[fileId]
  if (!br) return { text: '未压制', cls: 'bg-gray-100 text-gray-500' }
  const map: Record<string, { text: string; cls: string }> = {
    queued: { text: '排队中', cls: 'bg-gray-200 text-gray-600' },
    processing: { text: '压制中', cls: 'bg-amber-100 text-amber-700' },
    completed: { text: '已完成', cls: 'bg-green-100 text-green-700' },
    failed: { text: '失败', cls: 'bg-red-100 text-red-600' },
    skipped: { text: '已跳过', cls: 'bg-blue-100 text-blue-600' },
  }
  return map[br.status] ?? { text: br.status, cls: 'bg-gray-100 text-gray-600' }
}

async function handleDeleteBurn(burnId: number) {
  const ok = await confirm('确认删除此压制记录及产物文件？')
  if (!ok) return
  const success = await store.deleteBurnRecord(burnId)
  if (success) {
    localLoaded.value = false
    await loadData()
    emit('refresh')
  }
}

function handlePlayBurn(burnId: number) {
  const streamUrl = `/api/danmaku/burn_output/${burnId}/stream`
  window.open(streamUrl, '_blank')
}
</script>

<template>
  <div class="mt-3 border-t border-dashed border-gray-200 bg-gray-50/50 rounded-b-lg">
    <!-- 加载中 -->
    <div v-if="loading" class="flex items-center justify-center gap-2 py-4">
      <div
        class="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"
      />
      <span class="text-xs text-gray-500">加载分段...</span>
    </div>

    <!-- 无分段 -->
    <div
      v-else-if="localLoaded && files.length === 0"
      class="text-center py-3 text-xs text-gray-400"
    >
      无分段文件
    </div>

    <!-- 分段表格 -->
    <div v-else-if="localLoaded" class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead>
          <tr class="text-left text-gray-500 border-b border-gray-200">
            <th class="px-3 py-2 font-medium w-10 text-center">#</th>
            <th class="px-3 py-2 font-medium">文件名</th>
            <th class="px-3 py-2 font-medium w-20">大小</th>
            <th class="px-3 py-2 font-medium w-16">ASS</th>
            <th class="px-3 py-2 font-medium w-24">压制状态</th>
            <th class="px-3 py-2 font-medium">产物文件</th>
            <th class="px-3 py-2 font-medium w-48 text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="file in files"
            :key="file.id"
            class="border-b border-gray-100 hover:bg-gray-50/80 transition-colors"
          >
            <td class="px-3 py-2 text-center text-gray-400">
              {{ file.segment_index }}
            </td>
            <td class="px-3 py-2">
              <code
                class="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-700 max-w-[200px] inline-block truncate align-middle"
                :title="getFileName(file.file_path)"
                >{{ getFileName(file.file_path) }}</code
              >
            </td>
            <td class="px-3 py-2 text-gray-500">
              {{ formatFileSize(file.file_size) }}
            </td>
            <td class="px-3 py-2">
              <span
                class="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                :class="getAssBadge(file).cls"
                >{{ getAssBadge(file).text }}</span
              >
            </td>
            <td class="px-3 py-2">
              <span
                class="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                :class="getBurnBadge(file.id).cls"
                :title="burnMap[file.id]?.error || ''"
                >{{ getBurnBadge(file.id).text }}</span
              >
            </td>
            <td class="px-3 py-2">
              <template
                v-if="burnMap[file.id]?.status === 'completed' && burnMap[file.id]?.output_path"
              >
                <code
                  class="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-700 inline-block truncate max-w-[180px] align-middle"
                  :title="getFileName(burnMap[file.id].output_path)"
                  >{{ getFileName(burnMap[file.id].output_path) }}</code
                >
              </template>
              <span v-else class="text-gray-400">—</span>
            </td>
            <td class="px-3 py-2">
              <div class="flex items-center justify-end gap-1">
                <template v-if="burnMap[file.id]?.status === 'completed'">
                  <button
                    class="px-2 py-0.5 text-[11px] rounded border border-green-300 text-green-700 hover:bg-green-50 transition-colors"
                    @click="handlePlayBurn(burnMap[file.id].id)"
                  >
                    ▶
                  </button>
                  <a
                    v-if="burnMap[file.id]?.log_path"
                    :href="`/logs?file=${encodeURIComponent(getFileName(burnMap[file.id].log_path))}`"
                    target="_blank"
                    class="px-2 py-0.5 text-[11px] rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors no-underline"
                  >
                    日志
                  </a>
                  <button
                    class="px-2 py-0.5 text-[11px] rounded border border-red-300 text-red-600 hover:bg-red-50 transition-colors"
                    @click="handleDeleteBurn(burnMap[file.id].id)"
                  >
                    删除
                  </button>
                </template>
                <a
                  v-if="burnMap[file.id]?.status === 'failed' && burnMap[file.id]?.log_path"
                  :href="`/logs?file=${encodeURIComponent(getFileName(burnMap[file.id].log_path))}`"
                  target="_blank"
                  class="px-2 py-0.5 text-[11px] rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors no-underline"
                >
                  日志
                </a>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
