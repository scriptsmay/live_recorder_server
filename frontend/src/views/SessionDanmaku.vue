<script setup lang="ts">
/**
 * SessionDanmaku - 会话弹幕详情页
 *
 * 从 EJS session-danmaku.ejs 迁移而来
 * 功能：会话信息、弹幕录制状态、分段文件压制状态、弹幕搜索
 */
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { apiGet, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'

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
    ass_path: string
    started_at: string | null
    ended_at: string | null
    error: string | null
  } | null
  burnRecords: Array<{
    id: number
    recording_file_id: number
    session_id: number
    segment_index: number
    status: string
    output_path: string
    error: string | null
    log_path: string | null
    video_path: string | null
  }>
  files: Array<{
    id: number
    file_path: string
    file_size: number
    segment_index: number
    segment_start_ms: number | null
    segment_end_ms: number | null
    danmaku_ass_exists: boolean
    danmaku_ass_path: string | null
    file_exists: boolean
  }>
}

const detail = ref<SessionDetail | null>(null)
const loading = ref(false)
const notFound = ref(false)

// ---- Danmaku Search ----
const searchKeyword = ref('')
const searchResults = ref<Array<{ ts_ms: number; ts_str: string; text: string; username: string; user_id: string }>>([])
const searchTotal = ref(0)
const searchOffset = ref(0)
const searchLimit = 50
const searching = ref(false)
const searchExecuted = ref(false)

// ---- Computed ----
const sessionStatusBadge = computed(() => {
  if (!detail.value) return { text: '', cls: '' }
  const map: Record<string, { text: string; cls: string }> = {
    recording: { text: '录制中', cls: 'bg-green-100 text-green-700' },
    completed: { text: '已完成', cls: 'bg-blue-100 text-blue-700' },
    interrupted: { text: '中断', cls: 'bg-red-100 text-red-700' },
    pending: { text: '录制准备', cls: 'bg-gray-100 text-gray-500' },
  }
  return map[detail.value.session.status] || { text: detail.value.session.status, cls: 'bg-gray-100 text-gray-500' }
})

const captureStatusBadge = computed(() => {
  if (!detail.value?.capture) return { text: '未启用', cls: 'bg-gray-100 text-gray-500' }
  const map: Record<string, { text: string; cls: string }> = {
    recording: { text: '录制中', cls: 'bg-green-100 text-green-700' },
    completed: { text: '已完成', cls: 'bg-blue-100 text-blue-700' },
    failed: { text: '失败', cls: 'bg-red-100 text-red-700' },
  }
  return map[detail.value.capture.status] || { text: detail.value.capture.status, cls: 'bg-gray-100 text-gray-500' }
})

const roomDisplayName = computed(() => {
  if (!detail.value) return ''
  const { room, session } = detail.value
  return room ? room.room_name || room.room_url : session.room_url
})

// ---- Helpers ----
function formatDate(d: string | null | undefined) {
  if (!d) return '-'
  return new Date(d).toLocaleString('zh-CN')
}

function formatFileSize(bytes: number | null) {
  if (!bytes) return '-'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function formatMs(ms: number | null | undefined) {
  if (ms == null) return '-'
  return (ms / 1000).toFixed(0) + 's'
}

function fileName(filePath: string | null) {
  if (!filePath) return '-'
  return filePath.split('/').pop() || '-'
}

function burnRecordForFile(fileId: number) {
  return detail.value?.burnRecords.find((b) => b.recording_file_id === fileId)
}

function burnStatusBadge(status: string) {
  const map: Record<string, { text: string; cls: string }> = {
    queued: { text: '排队中', cls: 'bg-gray-100 text-gray-500' },
    processing: { text: '压制中', cls: 'bg-blue-100 text-blue-700' },
    completed: { text: '已完成', cls: 'bg-green-100 text-green-700' },
    failed: { text: '失败', cls: 'bg-red-100 text-red-700' },
    skipped: { text: '跳过', cls: 'bg-yellow-100 text-yellow-700' },
  }
  return map[status] || { text: status, cls: 'bg-gray-100 text-gray-500' }
}

function highlightKeyword(text: string, keyword: string): string {
  if (!keyword) return text
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('(' + escaped + ')', 'gi')
  return text.replace(re, '<mark class="bg-yellow-200 px-0.5 rounded">$1</mark>')
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

async function searchDanmaku() {
  searching.value = true
  searchExecuted.value = true
  try {
    const params = new URLSearchParams({
      session_id: sessionId.value,
      keyword: searchKeyword.value,
      limit: String(searchLimit),
      offset: String(searchOffset.value),
    })
    // API 返回 { status, data: [...], total, offset, limit }
    const res = await fetch('/api/danmaku/search?' + params.toString())
    const json = await res.json()

    if (!res.ok || json.status !== 'ok') {
      toast.error('弹幕搜索失败: ' + (json.message || '未知错误'))
      return
    }

    searchResults.value = json.data || []
    searchTotal.value = json.total || 0
  } catch (err) {
    toast.error('弹幕搜索异常: ' + (err instanceof Error ? err.message : String(err)))
  } finally {
    searching.value = false
  }
}

function handleSearch() {
  searchOffset.value = 0
  searchDanmaku()
}

function handleSearchKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    handleSearch()
  }
}

function prevPage() {
  searchOffset.value = Math.max(0, searchOffset.value - searchLimit)
  searchDanmaku()
}

function nextPage() {
  searchOffset.value += searchLimit
  searchDanmaku()
}

function logFileUrl(logPath: string | null) {
  if (!logPath) return ''
  const name = encodeURIComponent(logPath.split('/').pop() || '')
  return `/logs?file=${name}`
}

onMounted(() => {
  fetchDetail()
})
</script>

<template>
  <div>
    <!-- Loading -->
    <div v-if="loading" class="text-center py-16">
      <div class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
      <span class="text-sm text-gray-500">加载中...</span>
    </div>

    <!-- Not Found -->
    <div v-else-if="notFound" class="bg-white rounded-xl border border-gray-200 p-12 text-center shadow-sm">
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
          <h1 class="text-2xl font-bold text-gray-900">
            会话 #{{ detail.session.id }} 弹幕详情
          </h1>
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
                  <span class="text-xs font-medium px-2 py-0.5 rounded-full" :class="sessionStatusBadge.cls">
                    {{ sessionStatusBadge.text }}
                  </span>
                </dd>
              </div>
              <div class="flex">
                <dt class="text-gray-400 w-20 shrink-0">开始时间</dt>
                <dd class="text-gray-700">{{ formatDate(detail.session.started_at) }}</dd>
              </div>
              <div class="flex">
                <dt class="text-gray-400 w-20 shrink-0">结束时间</dt>
                <dd class="text-gray-700">{{ formatDate(detail.session.ended_at) }}</dd>
              </div>
              <div class="flex">
                <dt class="text-gray-400 w-20 shrink-0">输出路径</dt>
                <dd class="text-gray-700">
                  <code class="text-xs bg-gray-50 px-1.5 py-0.5 rounded break-all">{{ detail.session.output_path || '-' }}</code>
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <!-- Capture Info Card -->
        <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div class="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <span class="text-sm font-medium text-gray-700">弹幕录制</span>
            <span class="text-xs font-medium px-2 py-0.5 rounded-full" :class="captureStatusBadge.cls">
              {{ captureStatusBadge.text }}
            </span>
          </div>
          <div class="p-4">
            <template v-if="detail.capture">
              <dl class="space-y-2.5 text-xs">
                <div class="flex">
                  <dt class="text-gray-400 w-20 shrink-0">弹幕事件</dt>
                  <dd class="text-gray-700"><strong>{{ detail.capture.event_count || 0 }}</strong> 条</dd>
                </div>
                <div class="flex">
                  <dt class="text-gray-400 w-20 shrink-0">JSONL 路径</dt>
                  <dd class="text-gray-700">
                    <code class="text-xs bg-gray-50 px-1.5 py-0.5 rounded break-all">{{ detail.capture.raw_path || '-' }}</code>
                  </dd>
                </div>
                <div class="flex">
                  <dt class="text-gray-400 w-20 shrink-0">ASS 路径</dt>
                  <dd class="text-gray-700">
                    <code class="text-xs bg-gray-50 px-1.5 py-0.5 rounded break-all">{{ detail.capture.ass_path || '-' }}</code>
                  </dd>
                </div>
                <div class="flex">
                  <dt class="text-gray-400 w-20 shrink-0">开始采集</dt>
                  <dd class="text-gray-700">{{ formatDate(detail.capture.started_at) }}</dd>
                </div>
                <div class="flex">
                  <dt class="text-gray-400 w-20 shrink-0">结束采集</dt>
                  <dd class="text-gray-700">{{ formatDate(detail.capture.ended_at) }}</dd>
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

      <!-- Files & Burn Status Table -->
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-5">
        <div class="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
          <span class="text-sm font-medium text-gray-700">分段文件 &amp; 压制状态</span>
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
                <th class="text-left px-3 py-2 text-gray-500 font-medium">弹幕 ASS</th>
                <th class="text-left px-3 py-2 text-gray-500 font-medium">压制状态</th>
                <th class="text-left px-3 py-2 text-gray-500 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in detail.files" :key="f.id" class="border-b border-gray-50 hover:bg-gray-50/50">
                <td class="px-3 py-2 text-gray-600">{{ f.id }}</td>
                <td class="px-3 py-2 text-gray-600">{{ fileName(f.file_path) }}</td>
                <td class="px-3 py-2 text-gray-600">{{ formatFileSize(f.file_size) }}</td>
                <td class="px-3 py-2 text-gray-500">
                  {{ formatMs(f.segment_start_ms) }} ~ {{ formatMs(f.segment_end_ms) }}
                </td>
                <td class="px-3 py-2">
                  <span v-if="f.danmaku_ass_exists" class="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                    ASS 就绪
                  </span>
                  <span v-else-if="f.danmaku_ass_path" class="text-xs font-medium px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">
                    ASS 缺失
                  </span>
                  <span v-else class="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
                    &mdash;
                  </span>
                </td>
                <td class="px-3 py-2">
                  <template v-if="burnRecordForFile(f.id)">
                    <span
                      class="text-xs font-medium px-2 py-0.5 rounded-full"
                      :class="burnStatusBadge(burnRecordForFile(f.id)!.status).cls"
                      :title="burnRecordForFile(f.id)!.error || ''"
                    >
                      {{ burnStatusBadge(burnRecordForFile(f.id)!.status).text }}
                    </span>
                  </template>
                  <template v-else>
                    <span class="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">未压制</span>
                  </template>
                </td>
                <td class="px-3 py-2">
                  <template v-if="burnRecordForFile(f.id)">
                    <span v-if="burnRecordForFile(f.id)!.status === 'completed'" class="text-green-600">
                      &#10004; 已压制
                    </span>
                    <span v-else-if="burnRecordForFile(f.id)!.status === 'failed'" class="text-red-600" :title="burnRecordForFile(f.id)!.error || ''">
                      &#10008; 失败
                    </span>
                    <span v-else class="text-gray-400">
                      {{ burnRecordForFile(f.id)!.status }}
                    </span>
                    <a
                      v-if="burnRecordForFile(f.id)!.log_path"
                      :href="logFileUrl(burnRecordForFile(f.id)!.log_path)"
                      target="_blank"
                      class="ml-1.5 px-1.5 py-0.5 text-xs rounded border border-gray-300 text-gray-500 hover:bg-gray-50 no-underline"
                      :title="burnRecordForFile(f.id)!.log_path"
                    >
                      日志
                    </a>
                  </template>
                  <span v-else class="text-gray-400">&mdash;</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Danmaku Search Panel -->
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div class="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between flex-wrap gap-2">
          <span class="text-sm font-medium text-gray-700">弹幕搜索</span>
          <div class="flex items-center gap-2">
            <input
              v-model="searchKeyword"
              type="text"
              class="px-3 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent w-60"
              placeholder="搜索弹幕内容或用户名..."
              @keydown="handleSearchKeydown"
            />
            <button
              class="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
              @click="handleSearch"
            >
              搜索
            </button>
          </div>
        </div>
        <div class="p-4">
          <!-- Searching -->
          <div v-if="searching" class="text-center py-6">
            <div class="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
            <span class="text-xs text-gray-400">搜索中...</span>
          </div>

          <!-- Not yet searched -->
          <p v-else-if="!searchExecuted" class="text-xs text-gray-400 text-center py-4">输入关键词搜索弹幕</p>

          <!-- No results -->
          <p v-else-if="searchResults.length === 0" class="text-xs text-gray-400 text-center py-4">无匹配弹幕</p>

          <!-- Results -->
          <template v-else>
            <div class="mb-2 text-xs text-gray-400">
              共 {{ searchTotal }} 条匹配 (显示 {{ searchOffset + 1 }}-{{ Math.min(searchOffset + searchResults.length, searchTotal) }})
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead>
                  <tr class="bg-gray-50 border-b border-gray-100">
                    <th class="text-left px-3 py-2 text-gray-500 font-medium w-24">时间</th>
                    <th class="text-left px-3 py-2 text-gray-500 font-medium w-32">用户</th>
                    <th class="text-left px-3 py-2 text-gray-500 font-medium">弹幕内容</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(d, idx) in searchResults" :key="idx" class="border-b border-gray-50 hover:bg-gray-50/50">
                    <td class="px-3 py-1.5 text-gray-500">{{ d.ts_str || '-' }}</td>
                    <td class="px-3 py-1.5 text-gray-600">{{ d.username || '-' }}</td>
                    <td class="px-3 py-1.5 text-gray-700" v-html="highlightKeyword(d.text, searchKeyword)" />
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Pagination -->
            <div v-if="searchTotal > searchLimit" class="flex items-center gap-2 mt-3">
              <button
                v-if="searchOffset > 0"
                class="px-3 py-1 text-xs font-medium rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                @click="prevPage"
              >
                上一页
              </button>
              <button
                v-if="searchOffset + searchLimit < searchTotal"
                class="px-3 py-1 text-xs font-medium rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                @click="nextPage"
              >
                下一页
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
