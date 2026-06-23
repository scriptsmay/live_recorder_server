<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { apiGet, apiPost, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'

const toast = useToast()

// ---- 数据源 ----
interface RecordingOption {
  id: number
  room_name: string
  started_at: string
  output_path: string
}

interface ReplayOption {
  id: number
  principal_name: string
  replay_id: string
  final_file_paths: string
  raw_file_path: string
  start_time: string | null
  duration: number | null
}

interface SessionOption {
  id: number
  room_name: string
  danmaku_event_count: number
  started_at: string
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
const sourceType = ref<'recording' | 'replay'>('replay')
const sourceId = ref<number | null>(null)
const selectedFileIndex = ref(0)
const danmakuSessionId = ref<number | null>(null)
const manualAdjustSec = ref(0)
const videoWidth = ref(1920)
const videoHeight = ref(1080)
const submitting = ref(false)

// ---- 选项列表 ----
const recordings = ref<RecordingOption[]>([])
const replays = ref<ReplayOption[]>([])
const sessions = ref<SessionOption[]>([])
const records = ref<FreeBurnRecord[]>([])
const recordsTotal = ref(0)
const recordsPage = ref(1)

// ---- 加载选项 ----
async function loadRecordings() {
  try {
    const res = await apiGet<{ rows: RecordingOption[] }>('/api/recordings?status=completed&limit=100')
    recordings.value = res.data?.rows ?? []
  } catch { /* ignore */ }
}

async function loadReplays() {
  try {
    const res = await apiGet<{ data: ReplayOption[] }>('/api/replay/records?status=completed&limit=100')
    replays.value = res.data?.data ?? res.data ?? []
  } catch { /* ignore */ }
}

async function loadSessions() {
  try {
    const res = await apiGet<{ data: SessionOption[] }>('/api/danmaku-toolbox/sessions')
    sessions.value = (res.data?.data ?? res.data ?? []).filter(
      (s: SessionOption) => s.danmaku_event_count > 0,
    )
  } catch { /* ignore */ }
}

async function loadRecords() {
  try {
    const res = await apiGet<{ data: FreeBurnRecord[]; total: number }>(
      `/api/danmaku/free-burn/records?page=${recordsPage.value}&limit=10`,
    )
    records.value = res.data ?? []
    recordsTotal.value = res.total ?? 0
  } catch { /* ignore */ }
}

// ---- 选中的回放文件列表 ----
const replayFiles = ref<string[]>([])
const selectedReplay = ref<ReplayOption | null>(null)

function onReplaySelect() {
  selectedReplay.value = replays.value.find((r) => r.id === sourceId.value) ?? null
  if (selectedReplay.value) {
    try {
      replayFiles.value = JSON.parse(selectedReplay.value.final_file_paths || '[]')
    } catch {
      replayFiles.value = []
    }
  } else {
    replayFiles.value = []
  }
  selectedFileIndex.value = 0
}

// ---- 提交 ----
async function handleSubmit() {
  if (!sourceId.value || !danmakuSessionId.value) {
    toast.error('请选择视频来源和弹幕会话')
    return
  }

  submitting.value = true
  try {
    const res = await apiPost<{ id: number; offset_ms: number }>('/api/danmaku/free-burn', {
      source_type: sourceType.value,
      source_id: sourceId.value,
      selected_file_index: selectedFileIndex.value,
      danmaku_session_id: danmakuSessionId.value,
      manual_adjust_ms: manualAdjustSec.value * 1000,
      video_width: videoWidth.value,
      video_height: videoHeight.value,
    })
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
    case 'completed': return { text: '完成', cls: 'bg-green-100 text-green-700' }
    case 'processing': return { text: '处理中', cls: 'bg-blue-100 text-blue-700' }
    case 'failed': return { text: '失败', cls: 'bg-red-100 text-red-700' }
    default: return { text: '等待', cls: 'bg-gray-100 text-gray-600' }
  }
}

function basename(filePath: string) {
  return filePath.split('/').pop() || filePath
}

// ---- 生命周期 ----
onMounted(() => {
  loadRecordings()
  loadReplays()
  loadSessions()
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
          <!-- 视频来源类型 -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">视频来源</label>
            <div class="flex gap-2">
              <button
                class="px-3 py-1.5 text-sm rounded-lg border transition-colors"
                :class="sourceType === 'replay'
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50'"
                @click="sourceType = 'replay'; sourceId = null; replayFiles = []"
              >
                回放文件
              </button>
              <button
                class="px-3 py-1.5 text-sm rounded-lg border transition-colors"
                :class="sourceType === 'recording'
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50'"
                @click="sourceType = 'recording'; sourceId = null"
              >
                录制文件
              </button>
            </div>
          </div>

          <!-- 选择视频 -->
          <div v-if="sourceType === 'replay'">
            <label class="block text-sm font-medium text-gray-700 mb-1">选择回放</label>
            <select
              v-model="sourceId"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
              @change="onReplaySelect"
            >
              <option :value="null" disabled>请选择回放记录</option>
              <option v-for="r in replays" :key="r.id" :value="r.id">
                {{ r.principal_name || r.replay_id }} — {{ r.start_time || '未知时间' }}
              </option>
            </select>
            <div v-if="replayFiles.length > 1" class="mt-2">
              <label class="block text-xs text-gray-500 mb-1">选择文件分段（共 {{ replayFiles.length }} 个）</label>
              <select
                v-model="selectedFileIndex"
                class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
              >
                <option v-for="(fp, i) in replayFiles" :key="i" :value="i">
                  #{{ i }} — {{ basename(fp) }}
                </option>
              </select>
            </div>
          </div>
          <div v-else>
            <label class="block text-sm font-medium text-gray-700 mb-1">选择录制文件</label>
            <select
              v-model="sourceId"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
            >
              <option :value="null" disabled>请选择录制文件</option>
              <option v-for="r in recordings" :key="r.id" :value="r.id">
                {{ r.room_name || `录制 #${r.id}` }} — {{ r.started_at }}
              </option>
            </select>
          </div>

          <!-- 弹幕会话 -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">弹幕会话</label>
            <select
              v-model="danmakuSessionId"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
            >
              <option :value="null" disabled>请选择弹幕来源会话</option>
              <option v-for="s in sessions" :key="s.id" :value="s.id">
                #{{ s.id }} — {{ s.room_name || '未知' }}（{{ s.danmaku_event_count }} 条弹幕）
              </option>
            </select>
          </div>

          <!-- 手动偏移 -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              手动偏移调整（秒）
              <span class="text-gray-400 font-normal">— 可选，叠加在自动偏移之上</span>
            </label>
            <input
              v-model.number="manualAdjustSec"
              type="number"
              step="1"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
              placeholder="0"
            />
          </div>

          <!-- 分辨率 -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">宽度</label>
              <input
                v-model.number="videoWidth"
                type="number"
                class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">高度</label>
              <input
                v-model.number="videoHeight"
                type="number"
                class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
              />
            </div>
          </div>

          <!-- 提交 -->
          <button
            class="w-full px-4 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="submitting || !sourceId || !danmakuSessionId"
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
            <div class="flex items-center justify-between gap-2">
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
                    {{ rec.source_type === 'replay' ? '回放' : '录制' }} + 会话 #{{ rec.danmaku_session_id }}
                  </span>
                </div>
                <div class="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                  <span>偏移 {{ rec.offset_ms }}ms</span>
                  <span class="text-gray-200">·</span>
                  <span>{{ basename(rec.video_path) }}</span>
                </div>
                <div v-if="rec.status === 'failed' && rec.error_message" class="mt-0.5 text-xs text-red-500 truncate">
                  {{ rec.error_message }}
                </div>
              </div>
              <div class="text-xs text-gray-400 shrink-0">
                {{ rec.completed_at || rec.created_at }}
              </div>
            </div>
          </div>
        </div>

        <div v-if="recordsTotal > 10" class="px-6 py-3 border-t border-gray-100 flex justify-center">
          <button
            class="text-xs text-gray-500 hover:text-brand-600 transition-colors"
            @click="recordsPage++; loadRecords()"
          >
            加载更多 ({{ recordsTotal }} 条)
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
