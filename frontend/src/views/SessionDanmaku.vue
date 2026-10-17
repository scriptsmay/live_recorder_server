<script setup lang="ts">
/**
 * SessionDanmaku - 会话弹幕详情页
 *
 * 功能：采集指标概览、AI 弹幕分析（亮点时间轴）、会话与采集信息、分段文件、弹幕搜索。
 *
 * 设计：Linear Aesthetic —— 吸顶操作栏 + StatCard 指标卡 + 超细描边信息卡 +
 * 亮点强度条；全部使用语义色类（gray-* / brand-* / hairline-card），
 * 自动适配亮/深双主题。
 */
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { apiGet, apiPost, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import { formatBytes } from '@/utils/lib'
import StatCard from '@/components/ui/StatCard.vue'
import DanmakuSearchPanel from '@/components/Danmaku/DanmakuSearchPanel.vue'

const route = useRoute()
const toast = useToast()

const sessionId = computed(() => route.params.id as string)

const btnGhost =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50'

const btnPrimary =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-all hover:bg-brand-700 glow-accent disabled:cursor-not-allowed disabled:opacity-50'

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
const loadError = ref('')

interface AiHighlight {
  start_ms: number
  end_ms: number
  score: number
  peak_weighted: number
  label?: string
  reason?: string
  samples?: string[]
}
interface AiRecord {
  session_id: number
  status: string
  summary: string | null
  model: string | null
  llm_ok: boolean
  llm_error: string | null
  threshold_mode: string | null
  highlights: AiHighlight[] | null
  stats: Record<string, unknown> | null
}

const aiRecord = ref<AiRecord | null>(null)
const aiLoading = ref(false)

function fmtHMS(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`
}

async function fetchAiRecord() {
  aiLoading.value = true
  try {
    const res = await apiGet<AiRecord>(`/api/danmaku-analysis/${sessionId.value}`)
    aiRecord.value = res.data
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      aiRecord.value = null
    } else {
      toast.error('加载 AI 分析失败: ' + (err instanceof ApiError ? err.message : String(err)))
    }
  } finally {
    aiLoading.value = false
  }
}

async function triggerAiAnalysis(force = false) {
  try {
    await apiPost(`/api/danmaku-analysis/${sessionId.value}${force ? '?force=true' : ''}`)
    toast.success('已入队分析，稍后刷新查看')
    setTimeout(fetchAiRecord, 3000)
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '触发分析失败')
  }
}

// ---- Computed ----
const sessionStatusBadge = computed(() => {
  const s = detail.value?.session.status ?? ''
  const map: Record<string, { text: string; pill: string; dot: string }> = {
    recording: {
      text: '录制中',
      pill: 'border-green-200 bg-green-50 text-green-700',
      dot: 'bg-green-500 animate-pulse',
    },
    completed: {
      text: '已完成',
      pill: 'border-blue-200 bg-blue-50 text-blue-600',
      dot: 'bg-blue-500',
    },
    interrupted: {
      text: '中断',
      pill: 'border-red-200 bg-red-50 text-red-600',
      dot: 'bg-red-500',
    },
    pending: {
      text: '录制准备',
      pill: 'border-gray-200 bg-gray-50 text-gray-500',
      dot: 'bg-gray-400',
    },
  }
  return (
    map[s] ?? {
      text: s || '-',
      pill: 'border-gray-200 bg-gray-50 text-gray-500',
      dot: 'bg-gray-400',
    }
  )
})

const captureStatusBadge = computed(() => {
  const s = detail.value?.capture?.status
  if (!s) return { text: '未启用', pill: 'border-gray-200 bg-gray-50 text-gray-500' }
  const map: Record<string, { text: string; pill: string }> = {
    recording: { text: '采集中', pill: 'border-green-200 bg-green-50 text-green-700' },
    completed: { text: '已完成', pill: 'border-blue-200 bg-blue-50 text-blue-600' },
    failed: { text: '失败', pill: 'border-red-200 bg-red-50 text-red-600' },
  }
  return map[s] ?? { text: s, pill: 'border-gray-200 bg-gray-50 text-gray-500' }
})

const roomDisplayName = computed(() => {
  if (!detail.value) return ''
  const { room, session } = detail.value
  return room ? room.room_name || room.room_url : session.room_url
})

const filesTotalSize = computed(() =>
  // file_size 由 pg bigint 返回为字符串，必须先转 Number 再累加，否则会变成字符串拼接
  (detail.value?.files ?? []).reduce((sum, f) => sum + (Number(f.file_size) || 0), 0),
)

const durationText = computed(() => {
  const s = detail.value?.session
  if (!s?.started_at) return '—'
  const start = new Date(s.started_at).getTime()
  const end = s.ended_at ? new Date(s.ended_at).getTime() : Date.now()
  const sec = Math.max(0, Math.round((end - start) / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec % 60}s`
  return `${sec}s`
})

const statCards = computed(() => [
  {
    label: '弹幕事件',
    value: String(detail.value?.capture?.event_count ?? 0),
    sublines: [`采集状态：${captureStatusBadge.value.text}`],
    tone: 'cyan',
    iconPath:
      'M8.25 6.75h7.5M8.25 11.25h4.5m-9 8.25h9a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3h-9a3 3 0 0 0-3 3v13.5Z',
  },
  {
    label: '分段文件',
    value: String(detail.value?.files.length ?? 0),
    sublines: ['已写入磁盘'],
    tone: 'indigo',
    iconPath:
      'm15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z',
  },
  {
    label: '录制时长',
    value: durationText.value,
    sublines: ['开始至结束'],
    tone: 'emerald',
    iconPath: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  },
  {
    label: '文件总大小',
    value: formatBytes(filesTotalSize.value),
    sublines: ['全部录制分片'],
    tone: 'purple',
    iconPath:
      'M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 5.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125',
  },
])

const aiHighlights = computed(() => aiRecord.value?.highlights ?? [])

const maxPeak = computed(() => Math.max(1, ...aiHighlights.value.map((h) => h.peak_weighted || 0)))

function peakWidth(h: AiHighlight) {
  const pct = Math.round(((h.peak_weighted || 0) / maxPeak.value) * 100)
  return `${Math.max(4, Math.min(100, pct))}%`
}

const aiDone = computed(() =>
  Boolean(aiRecord.value && !['running', 'pending'].includes(aiRecord.value.status)),
)

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
  loadError.value = ''
  try {
    const res = await apiGet<SessionDetail>(`/api/sessions/${sessionId.value}/danmaku-page`)
    detail.value = res.data
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      notFound.value = true
    } else {
      loadError.value = err instanceof ApiError ? err.message : String(err)
      toast.error('加载弹幕详情失败: ' + loadError.value)
    }
  } finally {
    loading.value = false
  }
}

async function refresh() {
  await fetchDetail()
  await fetchAiRecord()
}

onMounted(() => {
  fetchDetail()
  fetchAiRecord()
})
</script>

<template>
  <div class="pb-16">
    <!-- 加载骨架 -->
    <div v-if="loading" class="space-y-4">
      <div class="flex items-center gap-3">
        <div class="h-9 w-9 animate-pulse rounded-lg bg-gray-100" />
        <div class="space-y-2">
          <div class="h-5 w-56 animate-pulse rounded bg-gray-200" />
          <div class="h-3 w-40 animate-pulse rounded bg-gray-100" />
        </div>
      </div>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div v-for="n in 4" :key="n" class="hairline-card h-[136px] animate-pulse rounded-xl" />
      </div>
      <div class="hairline-card h-40 animate-pulse rounded-xl" />
    </div>

    <!-- 未找到 -->
    <div v-else-if="notFound" class="hairline-card rounded-xl px-6 py-16 text-center">
      <div
        class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-gray-200 bg-gray-50 text-gray-400"
      >
        <svg
          class="h-6 w-6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
          />
        </svg>
      </div>
      <p class="text-sm font-medium text-gray-500">会话不存在</p>
      <p class="mt-1 text-xs text-gray-400">该会话可能已被删除</p>
      <router-link
        to="/sessions"
        class="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-xs font-medium text-gray-600 no-underline transition-colors hover:bg-gray-50"
      >
        返回会话列表
      </router-link>
    </div>

    <!-- 加载失败 -->
    <div v-else-if="loadError" class="hairline-card rounded-xl px-6 py-16 text-center">
      <div
        class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-red-200 bg-red-50 text-red-500"
      >
        <svg
          class="h-6 w-6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
          />
        </svg>
      </div>
      <p class="text-sm font-medium text-gray-600">加载失败</p>
      <p class="mt-1 break-all text-xs text-gray-400">{{ loadError }}</p>
      <div class="mt-4 flex items-center justify-center gap-2">
        <button
          class="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-700"
          @click="refresh"
        >
          重试
        </button>
        <router-link
          to="/sessions"
          class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-xs font-medium text-gray-600 no-underline transition-colors hover:bg-gray-50"
        >
          返回会话列表
        </router-link>
      </div>
    </div>

    <!-- 内容 -->
    <div v-else-if="detail">
      <!-- 吸顶操作栏 -->
      <header
        class="sticky top-14 z-30 -mx-4 mb-6 border-b border-gray-200/70 bg-surface/80 px-4 py-4 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-3">
            <router-link
              to="/sessions"
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 no-underline transition-colors hover:bg-gray-50 hover:text-gray-900"
              title="返回会话列表"
            >
              <svg
                class="h-4 w-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M10.5 19.5 3 12l7.5-7.5M3.75 12h16.5"
                />
              </svg>
            </router-link>
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h1 class="truncate text-xl font-semibold tracking-tight text-gray-900">
                  会话 #{{ detail.session.id }} 弹幕详情
                </h1>
                <span
                  class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium"
                  :class="sessionStatusBadge.pill"
                >
                  <span class="h-1.5 w-1.5 rounded-full" :class="sessionStatusBadge.dot" />
                  {{ sessionStatusBadge.text }}
                </span>
              </div>
              <p class="mt-0.5 truncate text-xs text-gray-500" :title="roomDisplayName">
                {{ roomDisplayName }}
              </p>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <a
              v-if="detail.capture?.raw_path"
              :href="`/api/danmaku/sessions/${sessionId}/raw`"
              download
              :class="[btnGhost, 'no-underline']"
            >
              <svg
                class="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 4.5v11.25m0 0-4.5-4.5m4.5 4.5 4.5-4.5M4.5 19.5h15"
                />
              </svg>
              下载 JSONL
            </a>
            <button :class="btnGhost" :disabled="loading" @click="refresh">
              <svg
                class="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
                />
              </svg>
              刷新
            </button>
          </div>
        </div>
      </header>

      <!-- 指标卡片 -->
      <div class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          v-for="card in statCards"
          :key="card.label"
          :label="card.label"
          :value="card.value"
          :sublines="card.sublines"
          :tone="card.tone"
          :icon-path="card.iconPath"
        />
      </div>

      <!-- AI 分析 -->
      <section class="hairline-card mb-5 overflow-hidden rounded-xl">
        <div
          class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200/70 px-4 py-3"
        >
          <div class="flex items-center gap-2.5">
            <span
              class="flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 bg-brand-500/10 text-brand-600"
            >
              <svg
                class="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z"
                />
              </svg>
            </span>
            <span class="text-sm font-semibold tracking-tight text-gray-900">AI 弹幕分析</span>
            <span
              v-if="aiRecord?.model"
              class="rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[11px] text-gray-500"
            >
              {{ aiRecord.model }}
            </span>
            <span
              v-if="aiRecord && aiHighlights.length"
              class="rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-600"
            >
              {{ aiHighlights.length }} 个亮点
            </span>
          </div>

          <div class="flex items-center gap-1.5">
            <template v-if="aiRecord && ['completed', 'no_danmaku'].includes(aiRecord.status)">
              <a
                :href="`/api/danmaku-analysis/${sessionId}/report`"
                target="_blank"
                :class="[btnGhost, 'no-underline']"
              >
                <svg
                  class="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                  />
                </svg>
                查看报告
              </a>
              <button
                :class="[btnGhost, 'text-amber-600 hover:border-amber-200 hover:bg-amber-50']"
                @click="triggerAiAnalysis(true)"
              >
                重算
              </button>
            </template>
            <button
              v-else-if="!aiRecord || aiRecord.status === 'failed'"
              :class="btnPrimary"
              :disabled="aiLoading"
              @click="triggerAiAnalysis()"
            >
              <svg
                class="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M5.25 5.653c0-.856.917-1.402 1.669-.981l11.662 6.847a1.121 1.121 0 0 1 0 1.948l-11.662 6.847a1.121 1.121 0 0 1-1.669-.981V5.653Z"
                />
              </svg>
              立即分析
            </button>
            <span
              v-else
              class="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600"
            >
              <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              分析中…
            </span>
          </div>
        </div>

        <div class="px-4 py-4">
          <template v-if="aiDone">
            <p v-if="aiRecord?.summary" class="text-sm leading-relaxed text-gray-700">
              {{ aiRecord.summary }}
            </p>
            <p
              v-else-if="aiRecord?.llm_error"
              class="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 p-2.5 text-xs text-amber-700"
            >
              <svg
                class="mt-0.5 h-3.5 w-3.5 shrink-0"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
                />
              </svg>
              <span>LLM 未成功（以下为纯统计结果）：{{ aiRecord.llm_error }}</span>
            </p>
            <p
              v-else-if="aiRecord?.status === 'no_danmaku'"
              class="rounded-lg border border-gray-200 bg-gray-50/60 p-2.5 text-xs text-gray-500"
            >
              该会话无可分析弹幕
            </p>

            <!-- 亮点列表 -->
            <div v-if="aiHighlights.length" class="mt-3 space-y-2.5">
              <div
                v-for="(h, i) in aiHighlights"
                :key="i"
                class="rounded-xl border border-gray-200/70 bg-gray-50/50 p-3"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class="rounded-md border border-brand-200 bg-brand-50 px-1.5 py-0.5 font-mono text-[11px] text-brand-600"
                  >
                    {{ fmtHMS(h.start_ms) }} → {{ fmtHMS(h.end_ms) }}
                  </span>
                  <span v-if="h.label" class="text-sm font-medium text-gray-900">{{
                    h.label
                  }}</span>
                </div>

                <div class="mt-2 flex items-center gap-2.5">
                  <div class="h-1 flex-1 overflow-hidden rounded-full bg-gray-200/70">
                    <div
                      class="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-400"
                      :style="{ width: peakWidth(h) }"
                    />
                  </div>
                  <span class="shrink-0 text-[11px] tabular-nums text-gray-400">
                    峰值 {{ h.peak_weighted }}
                  </span>
                </div>

                <p v-if="h.reason" class="mt-2 text-xs leading-relaxed text-gray-600">
                  {{ h.reason }}
                </p>

                <div v-if="h.samples && h.samples.length" class="mt-2 flex flex-wrap gap-1">
                  <span
                    v-for="(s, si) in h.samples.slice(0, 8)"
                    :key="si"
                    class="max-w-[220px] truncate rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-xs text-gray-600"
                    :title="s"
                    >{{ s }}</span
                  >
                </div>
              </div>
            </div>
          </template>

          <div v-else-if="!aiRecord && !aiLoading" class="flex items-center gap-3">
            <span
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 text-gray-300"
            >
              <svg
                class="h-4 w-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z"
                />
              </svg>
            </span>
            <div>
              <p class="text-sm text-gray-600">尚未分析</p>
              <p class="mt-0.5 text-xs text-gray-400">
                开启 AI 弹幕分析后可手动触发，或等待下播自动分析
              </p>
            </div>
          </div>

          <div v-else class="flex items-center gap-2 py-2 text-xs text-gray-400">
            <div
              class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"
            />
            加载分析结果…
          </div>
        </div>
      </section>

      <!-- 会话 / 采集信息 -->
      <div class="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <!-- 会话信息 -->
        <section class="hairline-card overflow-hidden rounded-xl">
          <div class="flex items-center gap-2 border-b border-gray-200/70 px-4 py-3">
            <svg
              class="h-3.5 w-3.5 text-gray-400"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"
              />
            </svg>
            <span class="text-[11px] font-medium uppercase tracking-wider text-gray-400"
              >会话信息</span
            >
          </div>
          <dl class="divide-y divide-gray-100/80 px-4 py-1">
            <div class="flex items-baseline gap-3 py-2.5">
              <dt class="w-20 shrink-0 text-xs text-gray-400">房间</dt>
              <dd class="min-w-0 break-all text-xs text-gray-700">{{ roomDisplayName }}</dd>
            </div>
            <div class="flex items-baseline gap-3 py-2.5">
              <dt class="w-20 shrink-0 text-xs text-gray-400">状态</dt>
              <dd>
                <span
                  class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                  :class="sessionStatusBadge.pill"
                >
                  <span class="h-1.5 w-1.5 rounded-full" :class="sessionStatusBadge.dot" />
                  {{ sessionStatusBadge.text }}
                </span>
              </dd>
            </div>
            <div class="flex items-baseline gap-3 py-2.5">
              <dt class="w-20 shrink-0 text-xs text-gray-400">开始时间</dt>
              <dd class="text-xs tabular-nums text-gray-700">
                {{ $formatTime(detail.session.started_at) }}
              </dd>
            </div>
            <div class="flex items-baseline gap-3 py-2.5">
              <dt class="w-20 shrink-0 text-xs text-gray-400">结束时间</dt>
              <dd class="text-xs tabular-nums text-gray-700">
                {{ $formatTime(detail.session.ended_at) }}
              </dd>
            </div>
            <div class="flex items-baseline gap-3 py-2.5">
              <dt class="w-20 shrink-0 text-xs text-gray-400">输出路径</dt>
              <dd class="min-w-0">
                <code class="break-all text-[11px]">{{ detail.session.output_path || '-' }}</code>
              </dd>
            </div>
          </dl>
        </section>

        <!-- 弹幕录制 -->
        <section class="hairline-card overflow-hidden rounded-xl">
          <div
            class="flex items-center justify-between gap-2 border-b border-gray-200/70 px-4 py-3"
          >
            <div class="flex items-center gap-2">
              <svg
                class="h-3.5 w-3.5 text-gray-400"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M8.25 6.75h7.5M8.25 11.25h4.5m-9 8.25h9a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3h-9a3 3 0 0 0-3 3v13.5Z"
                />
              </svg>
              <span class="text-[11px] font-medium uppercase tracking-wider text-gray-400"
                >弹幕录制</span
              >
            </div>
            <span
              class="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
              :class="captureStatusBadge.pill"
            >
              {{ captureStatusBadge.text }}
            </span>
          </div>

          <template v-if="detail.capture">
            <dl class="divide-y divide-gray-100/80 px-4 py-1">
              <div class="flex items-baseline gap-3 py-2.5">
                <dt class="w-20 shrink-0 text-xs text-gray-400">弹幕事件</dt>
                <dd class="text-xs tabular-nums text-gray-700">
                  <strong class="font-semibold text-gray-900">{{
                    detail.capture.event_count || 0
                  }}</strong>
                  条
                </dd>
              </div>
              <div class="flex items-baseline gap-3 py-2.5">
                <dt class="w-20 shrink-0 text-xs text-gray-400">JSONL 路径</dt>
                <dd class="flex min-w-0 items-center gap-2">
                  <code class="break-all text-[11px]">{{ detail.capture.raw_path || '-' }}</code>
                  <a
                    v-if="detail.capture.raw_path"
                    :href="`/api/danmaku/sessions/${sessionId}/raw`"
                    download
                    :class="[btnGhost, 'shrink-0 no-underline']"
                  >
                    下载
                  </a>
                </dd>
              </div>
              <div class="flex items-baseline gap-3 py-2.5">
                <dt class="w-20 shrink-0 text-xs text-gray-400">开始采集</dt>
                <dd class="text-xs tabular-nums text-gray-700">
                  {{ $formatTime(detail.capture.started_at) }}
                </dd>
              </div>
              <div class="flex items-baseline gap-3 py-2.5">
                <dt class="w-20 shrink-0 text-xs text-gray-400">结束采集</dt>
                <dd class="text-xs tabular-nums text-gray-700">
                  {{ $formatTime(detail.capture.ended_at) }}
                </dd>
              </div>
              <div v-if="detail.capture.error" class="flex items-baseline gap-3 py-2.5">
                <dt class="w-20 shrink-0 text-xs text-gray-400">错误</dt>
                <dd
                  class="flex min-w-0 items-start gap-2 rounded-lg border border-red-200 bg-red-50/60 p-2 text-xs text-red-600"
                >
                  <span class="break-all">{{ detail.capture.error }}</span>
                </dd>
              </div>
            </dl>
          </template>
          <p v-else class="px-4 py-6 text-center text-xs text-gray-400">该会话未启用弹幕录制</p>
        </section>
      </div>

      <!-- 分段文件 -->
      <section class="hairline-card mb-5 overflow-hidden rounded-xl">
        <div class="flex items-center justify-between gap-2 border-b border-gray-200/70 px-4 py-3">
          <div class="flex items-center gap-2">
            <svg
              class="h-3.5 w-3.5 text-gray-400"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
              />
            </svg>
            <span class="text-[11px] font-medium uppercase tracking-wider text-gray-400"
              >分段文件</span
            >
          </div>
          <span class="text-[11px] tabular-nums text-gray-400"
            >{{ detail.files.length }} 个文件</span
          >
        </div>

        <p v-if="detail.files.length === 0" class="px-4 py-6 text-center text-xs text-gray-400">
          无分段文件
        </p>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr
                class="whitespace-nowrap border-b border-gray-200/70 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400"
              >
                <th class="w-16 px-4 py-2.5">#</th>
                <th class="px-4 py-2.5">文件名</th>
                <th class="w-28 px-4 py-2.5">大小</th>
                <th class="w-56 px-4 py-2.5">分段时间</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100/80">
              <tr
                v-for="f in detail.files"
                :key="f.id"
                class="transition-colors hover:bg-gray-50/70"
              >
                <td class="px-4 py-2.5 font-mono tabular-nums text-gray-400">#{{ f.id }}</td>
                <td class="px-4 py-2.5 font-mono text-gray-700">
                  <span class="break-all">{{ fileName(f.file_path) }}</span>
                </td>
                <td class="whitespace-nowrap px-4 py-2.5 tabular-nums text-gray-600">
                  {{ formatBytes(f.file_size) }}
                </td>
                <td class="whitespace-nowrap px-4 py-2.5 tabular-nums text-gray-500">
                  {{ formatSegmentTime(f.segment_start_ms, f.segment_end_ms) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 弹幕搜索 -->
      <section class="hairline-card overflow-hidden rounded-xl">
        <div class="flex items-center gap-2 border-b border-gray-200/70 px-4 py-3">
          <svg
            class="h-3.5 w-3.5 text-gray-400"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
            />
          </svg>
          <span class="text-[11px] font-medium uppercase tracking-wider text-gray-400"
            >弹幕搜索</span
          >
        </div>
        <div class="p-4">
          <DanmakuSearchPanel :session-id="sessionId" />
        </div>
      </section>
    </div>
  </div>
</template>
