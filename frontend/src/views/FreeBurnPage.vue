<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { apiGet, apiPost, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import { formatBytes } from '@/utils/lib'
import type { ManagedFile } from '@/types/file-manage'
import FilePickerModal from '@/components/Files/FilePickerModal.vue'
import DanmakuPickerModal from '@/components/Danmaku/DanmakuPickerModal.vue'

const toast = useToast()

// ---- 数据源 ----
interface SessionOption {
  id: number
  room_name: string | null
  danmaku_event_count: number
  started_at: string | null
}

interface FreeBurnRecord {
  id: number
  source_type: string
  source_id: number
  danmaku_session_id: number
  video_path: string
  offset_ms: number
  manual_adjust_ms: number
  status: string
  output_path: string
  error_message: string
  created_at: string
  completed_at: string | null
}

// ---- 表单状态 ----
const selectedVideoFile = ref<ManagedFile | null>(null)
const showVideoPicker = ref(false)
const selectedSession = ref<SessionOption | null>(null)
const showDanmakuPicker = ref(false)
const manualAdjustSec = ref(0)
const videoWidth = ref<number | null>(1920)
const videoHeight = ref<number | null>(1080)
const userEditedResolution = ref(false)
const submitting = ref(false)

// ---- 选项列表 ----
const records = ref<FreeBurnRecord[]>([])
const recordsTotal = ref(0)
const recordsPage = ref(1)

// ---- 解析分辨率 ----
function parseResolution(resolution: string | null): { width: number; height: number } | null {
  if (!resolution) return null
  const match = resolution.match(/^(\d{2,5})x(\d{2,5})$/)
  if (!match) return null
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) }
}

// ---- 视频文件选择 ----
function onVideoFileSelect(file: ManagedFile) {
  selectedVideoFile.value = file
  showVideoPicker.value = false
  userEditedResolution.value = false

  // 尝试从分辨率字段自动填充
  if (file.source_table === 'replay_records' && file.source_id) {
    apiGet<{ resolution?: string }>(`/api/replay/records/${file.source_id}`)
      .then((res) => {
        const parsed = parseResolution(res.data?.resolution ?? null)
        if (parsed && !userEditedResolution.value) {
          videoWidth.value = parsed.width
          videoHeight.value = parsed.height
        } else if (!parsed && !userEditedResolution.value) {
          videoWidth.value = null
          videoHeight.value = null
        }
      })
      .catch(() => {
        if (!userEditedResolution.value) {
          videoWidth.value = null
          videoHeight.value = null
        }
      })
  } else {
    // 非回放文件（如录制文件），无分辨率数据，保持空值
    if (!userEditedResolution.value) {
      videoWidth.value = null
      videoHeight.value = null
    }
  }
}

// ---- 弹幕会话选择 ----
function onSessionSelect(session: SessionOption) {
  selectedSession.value = session
  showDanmakuPicker.value = false
}

// ---- 用户手动修改分辨率 ----
function onResolutionInput() {
  userEditedResolution.value = true
}

// ---- 加载历史 ----
async function loadRecords() {
  try {
    const res = await apiGet<FreeBurnRecord[]>(
      `/api/danmaku/free-burn/records?page=${recordsPage.value}&limit=10`,
    )
    records.value = res.data ?? []
    recordsTotal.value = res.total ?? 0
  } catch {
    /* ignore */
  }
}

function nextPage() {
  recordsPage.value += 1
  loadRecords()
}

// ---- 提交 ----
async function handleSubmit() {
  if (!selectedVideoFile.value || !selectedSession.value) {
    toast.error('请选择视频文件和弹幕会话')
    return
  }

  submitting.value = true
  try {
    const payload: Record<string, unknown> = {
      video_path: selectedVideoFile.value.file_path,
      source_type: selectedVideoFile.value.category === 'replay' ? 'replay' : 'recording',
      source_id: selectedVideoFile.value.source_id,
      danmaku_session_id: selectedSession.value.id,
      manual_adjust_ms: manualAdjustSec.value * 1000,
    }
    // 宽高有值才传，null/空则不传，ffmpeg 保持原尺寸
    if (videoWidth.value != null && videoWidth.value > 0) {
      payload.video_width = videoWidth.value
    }
    if (videoHeight.value != null && videoHeight.value > 0) {
      payload.video_height = videoHeight.value
    }

    const res = await apiPost<{ id: number; offset_ms: number }>('/api/danmaku/free-burn', payload)
    toast.success(`自由压制任务已创建 #${res.data?.id}，偏移 ${res.data?.offset_ms ?? 0}ms`)
    loadRecords()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '创建任务失败')
  } finally {
    submitting.value = false
  }
}

// ---- 状态样式 ----
function statusBadge(status: string) {
  switch (status) {
    case 'completed':
      return { text: '完成', cls: 'bg-green-100 text-green-700' }
    case 'processing':
      return { text: '处理中', cls: 'bg-blue-100 text-blue-700' }
    case 'failed':
      return { text: '失败', cls: 'bg-red-100 text-red-700' }
    default:
      return { text: '等待', cls: 'bg-gray-100 text-gray-600' }
  }
}

function basename(filePath: string) {
  return filePath.split('/').pop() || filePath
}

// ---- 生命周期 ----
onMounted(() => {
  loadRecords()
})
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-gray-900 mb-6">自由压制</h1>
    <p class="text-sm text-gray-500 mb-6">
      将任意视频文件与弹幕数据组合压制，自动计算时间偏移。适用于回放视频 + 录制弹幕的场景。
    </p>

    <div class="grid grid-cols-1 xl:grid-cols-[1fr_1fr] gap-6">
      <!-- 左侧：创建任务 -->
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div class="px-6 py-3 border-b border-gray-200">
          <h2 class="text-sm font-semibold text-gray-900">创建压制任务</h2>
        </div>
        <div class="p-6 space-y-5">
          <!-- 选择视频文件 -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">视频文件</label>
            <button
              class="w-full px-3 py-2 text-sm text-left border border-gray-300 rounded-lg hover:border-brand-400 hover:bg-brand-50 transition-colors flex items-center justify-between"
              @click="showVideoPicker = true"
            >
              <template v-if="selectedVideoFile">
                <span class="text-gray-900 font-medium truncate">
                  {{ selectedVideoFile.file_name }}
                </span>
                <span class="text-gray-400 ml-2 shrink-0">
                  {{ formatBytes(selectedVideoFile.file_size) }}
                </span>
              </template>
              <template v-else>
                <span class="text-gray-400">点击选择视频文件...</span>
              </template>
            </button>
          </div>

          <!-- 弹幕会话 -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">弹幕会话</label>
            <button
              class="w-full px-3 py-2 text-sm text-left border border-gray-300 rounded-lg hover:border-brand-400 hover:bg-brand-50 transition-colors flex items-center justify-between"
              @click="showDanmakuPicker = true"
            >
              <template v-if="selectedSession">
                <span class="text-gray-900 font-medium truncate">
                  {{ selectedSession.room_name || '未知主播' }}
                </span>
                <span class="text-gray-400 ml-2 shrink-0">
                  {{ selectedSession.danmaku_event_count }} 条弹幕
                </span>
              </template>
              <template v-else>
                <span class="text-gray-400">点击选择弹幕会话...</span>
              </template>
            </button>
          </div>

          <!-- 手动偏移 -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1"> 手动偏移调整（秒） </label>
            <input
              v-model.number="manualAdjustSec"
              type="number"
              step="0.1"
              min="-60"
              max="60"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
              placeholder="0"
            />
            <p class="mt-1 text-xs text-gray-400">
              正值 = 弹幕延后出现，负值 = 弹幕提前出现。叠加在自动偏移之上
            </p>
          </div>

          <!-- 分辨率 -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">宽度</label>
              <input
                v-model.number="videoWidth"
                type="number"
                class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
                placeholder="自动"
                @input="onResolutionInput"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">高度</label>
              <input
                v-model.number="videoHeight"
                type="number"
                class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
                placeholder="自动"
                @input="onResolutionInput"
              />
            </div>
            <p class="col-span-2 text-xs text-gray-400">
              选择回放文件后自动填充，留空则保持视频原始尺寸
            </p>
          </div>

          <!-- 提交 -->
          <button
            class="w-full px-4 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="submitting || !selectedVideoFile || !selectedSession"
            @click="handleSubmit"
          >
            {{ submitting ? '提交中...' : '开始压制' }}
          </button>
        </div>
      </div>

      <!-- 右侧：任务历史 -->
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div class="px-6 py-3 border-b border-gray-200 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-gray-900">任务历史</h2>
          <button
            class="text-xs text-gray-400 hover:text-brand-600 transition-colors"
            @click="loadRecords"
          >
            刷新
          </button>
        </div>

        <div v-if="records.length === 0" class="p-8 text-center text-sm text-gray-400">
          暂无自由压制任务
        </div>

        <div v-else class="divide-y divide-gray-100">
          <div
            v-for="rec in records"
            :key="rec.id"
            class="px-6 py-3 hover:bg-gray-50 transition-colors"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-gray-900">#{{ rec.id }}</span>
                  <span
                    class="inline-block px-1.5 py-0.5 text-xs font-medium rounded-full"
                    :class="statusBadge(rec.status).cls"
                  >
                    {{ statusBadge(rec.status).text }}
                  </span>
                  <span class="text-xs text-gray-400">
                    {{ rec.source_type === 'replay' ? '回放' : '录制' }} + 会话 #{{
                      rec.danmaku_session_id
                    }}
                  </span>
                </div>
                <div class="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                  <span>偏移 {{ rec.offset_ms }}ms</span>
                  <span class="text-gray-200">·</span>
                  <span>手动偏移 {{ rec.manual_adjust_ms }}ms</span>
                  <span class="text-gray-200">·</span>
                  <span>{{ basename(rec.video_path) }}</span>
                  <span class="text-gray-200">·</span>
                  <span>结束时间 {{ $formatTime(rec.completed_at) }}</span>
                </div>
                <div
                  v-if="rec.status === 'failed' && rec.error_message"
                  class="mt-0.5 text-xs text-red-500 truncate"
                  :title="rec.error_message"
                >
                  {{ rec.error_message }}
                </div>
              </div>
              <div class="text-xs text-gray-400 shrink-0">
                {{ $formatTime(rec.created_at) }}
              </div>
            </div>
          </div>
        </div>

        <div
          v-if="recordsTotal > 10"
          class="px-6 py-3 border-t border-gray-100 flex justify-center"
        >
          <button
            class="text-xs text-gray-500 hover:text-brand-600 transition-colors"
            @click="nextPage()"
          >
            加载更多 ({{ recordsTotal }} 条)
          </button>
        </div>
      </div>
    </div>

    <!-- 文件选择 Modal -->
    <FilePickerModal
      v-model:visible="showVideoPicker"
      title="选择视频文件"
      :category="['recording', 'replay']"
      :model-value="selectedVideoFile"
      @select="onVideoFileSelect"
    />

    <!-- 弹幕会话选择 Modal -->
    <DanmakuPickerModal
      v-model:visible="showDanmakuPicker"
      :model-value="selectedSession?.id"
      @select="onSessionSelect"
    />
  </div>
</template>
