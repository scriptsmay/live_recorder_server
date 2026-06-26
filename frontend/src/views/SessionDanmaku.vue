<script setup lang="ts">
/**
 * SessionDanmaku - 会话弹幕详情页
 *
 * 从 EJS session-danmaku.ejs 迁移而来
 * 功能：会话信息、弹幕录制状态、弹幕搜索
 */
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { apiGet, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import { formatBytes } from '@/utils/lib'
import DanmakuSearchPanel from '@/components/Danmaku/DanmakuSearchPanel.vue'

const route = useRoute()
const toast = useToast()

const sessionId = computed(() => route.params.id as string)

// ---- Data ----
interface SessionDetail {
  session: {
    id: number
    room_url: string
    status: string
    started_at: string | null
    ended_at: string | null
    output_path: string
    output_dir?: string
  }
  room: { room_name: string; room_url: string } | null
  capture: {
    status: string
    event_count: number
    raw_path: string
    started_at: string | null
    ended_at: string | null
    error: string | null
  } | null
  files: Array<{
    id: number
    file_path: string
    file_size: number
    segment_index: number
    segment_start_ms: number | null
    segment_end_ms: number | null
    file_exists: boolean
  }>
}

const detail = ref<SessionDetail | null>(null)
const loading = ref(false)
const notFound = ref(false)

// ---- Computed ----
const sessionStatusBadge = computed(() => {
  if (!detail.value) return { text: '', cls: '' }
  const map: Record<string, { text: string; cls: string }> = {
    recording: { text: '录制中', cls: 'bg-green-100 text-green-700' },
    completed: { text: '已完成', cls: 'bg-blue-100 text-blue-700' },
    interrupted: { text: '中断', cls: 'bg-red-100 text-red-700' },
    pending: { text: '录制准备', cls: 'bg-gray-100 text-gray-500' },
  }
  return (
    map[detail.value.session.status] || {
      text: detail.value.session.status,
      cls: 'bg-gray-100 text-gray-500',
    }
  )
})

const captureStatusBadge = computed(() => {
  if (!detail.value?.capture) return { text: '未启用', cls: 'bg-gray-100 text-gray-500' }
  const map: Record<string, { text: string; cls: string }> = {
    recording: { text: '录制中', cls: 'bg-green-100 text-green-700' },
    completed: { text: '已完成', cls: 'bg-blue-100 text-blue-700' },
    failed: { text: '失败', cls: 'bg-red-100 text-red-700' },
  }
  return (
    map[detail.value.capture.status] || {
      text: detail.value.capture.status,
      cls: 'bg-gray-100 text-gray-500',
    }
  )
})

const roomDisplayName = computed(() => {
  if (!detail.value) return ''
  const { room, session } = detail.value
  return room ? room.room_name || room.room_url : session.room_url
})

// ---- Helpers ----
function formatMs(ms: number | null | undefined) {
  if (ms == null) return '-'
  return (ms / 1000).toFixed(0) + 's'
}

function formatSegmentTime(startMs: number | null | undefined, endMs: number | null | undefined) {
  if (startMs == null || endMs == null) return '-'
  if (endMs <= startMs) return '待补充'
  return `${formatMs(startMs)} ~ ${formatMs(endMs)}`
}

function fileName(filePath: string | null) {
  if (!filePath) return '-'
  return filePath.split('/').pop() || '-'
}

// ---- Data Fetching ----
async function fetchDetail() {
  loading.value = true
  notFound.value = false
  try {
    const res = await apiGet<SessionDetail>(`/api/sessions/${sessionId.value}/danmaku-page`)
    detail.value = res.data
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      notFound.value = true
    } else {
      toast.error('加载弹幕详情失败: ' + (err instanceof ApiError ? err.message : String(err)))
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchDetail()
})
</script>

<template>
  <div>
    <!-- Loading -->
    <div v-if="loading" class="text-center py-16">
      <div
        class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"
      />
      <span class="text-sm text-gray-500">加载中...</span>
    </div>

    <!-- Not Found -->
    <div
      v-else-if="notFound"
      class="bg-white rounded-xl border border-gray-200 p-12 text-center shadow-sm"
    >
      <p class="text-gray-500 mb-4">会话不存在</p>
      <router-link to="/sessions" class="text-sm text-brand-600 hover:text-brand-700 no-underline">
        返回会话列表
      </router-link>
    </div>

    <!-- Content -->
    <div v-else-if="detail">
      <!-- Page Header -->
      <div class="flex items-center justify-between mb-5 flex-wrap gap-2">
        <div class="flex items-center gap-3">
          <h1 class="text-2xl font-bold text-gray-900">会话 #{{ detail.session.id }} 弹幕详情</h1>
          <router-link
            to="/sessions"
            class="px-3 py-1 text-xs font-medium rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors no-underline"
          >
            返回列表
          </router-link>
        </div>
        <router-link
          to="/danmaku-toolbox"
          class="px-3 py-1.5 text-xs font-medium rounded-md border border-green-300 text-green-700 hover:bg-green-50 transition-colors no-underline"
        >
          弹幕工具箱 &rarr;
        </router-link>
      </div>

      <!-- Two-Column Info Cards -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
        <!-- Session Info Card -->
        <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div class="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
            <span class="text-sm font-medium text-gray-700">会话信息</span>
          </div>
          <div class="p-4">
            <dl class="space-y-2.5 text-xs">
              <div class="flex">
                <dt class="text-gray-400 w-20 shrink-0">房间</dt>
                <dd class="text-gray-700 break-all">{{ roomDisplayName }}</dd>
              </div>
              <div class="flex">
                <dt class="text-gray-400 w-20 shrink-0">状态</dt>
                <dd>
                  <span
                    class="text-xs font-medium px-2 py-0.5 rounded-full"
                    :class="sessionStatusBadge.cls"
                  >
                    {{ sessionStatusBadge.text }}
                  </span>
                </dd>
              </div>
              <div class="flex">
                <dt class="text-gray-400 w-20 shrink-0">开始时间</dt>
                <dd class="text-gray-700">{{ $formatTime(detail.session.started_at) }}</dd>
              </div>
              <div class="flex">
                <dt class="text-gray-400 w-20 shrink-0">结束时间</dt>
                <dd class="text-gray-700">{{ $formatTime(detail.session.ended_at) }}</dd>
              </div>
              <div class="flex">
                <dt class="text-gray-400 w-20 shrink-0">输出路径</dt>
                <dd class="text-gray-700">
                  <code class="text-xs bg-gray-50 px-1.5 py-0.5 rounded break-all">{{
                    detail.session.output_path || '-'
                  }}</code>
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <!-- Capture Info Card -->
        <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div
            class="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between"
          >
            <span class="text-sm font-medium text-gray-700">弹幕录制</span>
            <span
              class="text-xs font-medium px-2 py-0.5 rounded-full"
              :class="captureStatusBadge.cls"
            >
              {{ captureStatusBadge.text }}
            </span>
          </div>
          <div class="p-4">
            <template v-if="detail.capture">
              <dl class="space-y-2.5 text-xs">
                <div class="flex">
                  <dt class="text-gray-400 w-20 shrink-0">弹幕事件</dt>
                  <dd class="text-gray-700">
                    <strong>{{ detail.capture.event_count || 0 }}</strong> 条
                  </dd>
                </div>
                <div class="flex">
                  <dt class="text-gray-400 w-20 shrink-0">JSONL 路径</dt>
                  <dd class="text-gray-700 flex items-center gap-1.5">
                    <code class="text-xs bg-gray-50 px-1.5 py-0.5 rounded break-all">{{
                      detail.capture.raw_path || '-'
                    }}</code>
                    <a
                      v-if="detail.capture.raw_path"
                      :href="`/api/danmaku/sessions/${sessionId}/raw`"
                      download
                      class="px-2 py-0.5 text-[11px] rounded border border-blue-300 text-blue-600 hover:bg-blue-50 transition-colors no-underline whitespace-nowrap"
                    >
                      下载
                    </a>
                  </dd>
                </div>
                <div class="flex">
                  <dt class="text-gray-400 w-20 shrink-0">开始采集</dt>
                  <dd class="text-gray-700">{{ $formatTime(detail.capture.started_at) }}</dd>
                </div>
                <div class="flex">
                  <dt class="text-gray-400 w-20 shrink-0">结束采集</dt>
                  <dd class="text-gray-700">{{ $formatTime(detail.capture.ended_at) }}</dd>
                </div>
                <div v-if="detail.capture.error" class="flex">
                  <dt class="text-gray-400 w-20 shrink-0">错误</dt>
                  <dd class="text-red-600">{{ detail.capture.error }}</dd>
                </div>
              </dl>
            </template>
            <template v-else>
              <p class="text-xs text-gray-400">该会话未启用弹幕录制。</p>
            </template>
          </div>
        </div>
      </div>

      <!-- Files Table -->
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-5">
        <div class="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
          <span class="text-sm font-medium text-gray-700">分段文件</span>
        </div>
        <div v-if="detail.files.length === 0" class="p-6 text-center">
          <p class="text-xs text-gray-400">无分段文件</p>
        </div>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="bg-gray-50 border-b border-gray-100">
                <th class="text-left px-3 py-2 text-gray-500 font-medium">#</th>
                <th class="text-left px-3 py-2 text-gray-500 font-medium">文件名</th>
                <th class="text-left px-3 py-2 text-gray-500 font-medium">大小</th>
                <th class="text-left px-3 py-2 text-gray-500 font-medium">分段时间</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="f in detail.files"
                :key="f.id"
                class="border-b border-gray-50 hover:bg-gray-50/50"
              >
                <td class="px-3 py-2 text-gray-600">{{ f.id }}</td>
                <td class="px-3 py-2 text-gray-600">{{ fileName(f.file_path) }}</td>
                <td class="px-3 py-2 text-gray-600">{{ formatBytes(f.file_size) }}</td>
                <td class="px-3 py-2 text-gray-500">
                  {{ formatSegmentTime(f.segment_start_ms, f.segment_end_ms) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Danmaku Search Panel -->
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div class="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
          <span class="text-sm font-medium text-gray-700">弹幕搜索</span>
        </div>
        <div class="p-4">
          <DanmakuSearchPanel :session-id="sessionId" />
        </div>
      </div>
    </div>
  </div>
</template>
