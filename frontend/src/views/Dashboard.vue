<script setup lang="ts">
/**
 * 仪表盘 - 系统运维概览
 *
 * - 6 个统计卡片（录制、转码、轮询、弹幕、今日录制、今日投稿）
 * - 活跃录制表格
 * - 近期活动时间线
 * - 系统状态摘要
 * - 5 秒自动刷新（可暂停）
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ActivityTimeline from '@/components/ActivityTimeline.vue'
import { useAppStore } from '@/stores/app'
import { apiGet } from '@/utils/api'
import { formatBytes } from '@/utils/lib'
import type {
  DashboardDanmaku,
  DashboardPolling,
  DashboardStatus,
  DashboardSummary,
} from '@/types/api'

interface StatCard {
  label: string
  value: string
  sublines: string[]
  gradient: string
  accent: string
  iconPath: string
  warning?: string
}

const appStore = useAppStore()

const loading = ref(true)
const dashboard = ref<DashboardStatus | null>(null)
const dashboardError = ref('')
const autoRefresh = ref(true)
let refreshTimer: ReturnType<typeof setInterval> | null = null

const defaultPolling: DashboardPolling = {
  total_polled: 0,
  total_rooms: 0,
  currently_live: 0,
  platform_breakdown: {},
}

const defaultDanmaku: DashboardDanmaku = {
  active_captures: 0,
  burn_queue: {
    queue_length: 0,
    processing: 0,
    concurrency: 0,
  },
}

const defaultSummary: DashboardSummary = {
  sessions_today: 0,
  sessions_today_total_size: 0,
  interrupted_today: 0,
  uploads_today: 0,
  uploads_failed_today: 0,
  orphaned_files: 0,
  replay_pending: 0,
  replay_completed_today: 0,
  replay_completed_today_size: 0,
}

const polling = computed(() => dashboard.value?.polling ?? defaultPolling)
const danmaku = computed(() => dashboard.value?.danmaku ?? defaultDanmaku)
const summary = computed(() => dashboard.value?.summary ?? defaultSummary)
const recentActivity = computed(() => dashboard.value?.recent_activity ?? [])
const activeRecordings = computed(() => dashboard.value?.active_recordings ?? [])

const hasPolling = computed(() => dashboard.value?.polling !== undefined)
const hasDanmaku = computed(() => dashboard.value?.danmaku !== undefined)
const hasSummary = computed(() => dashboard.value?.summary !== undefined)

const statCards = computed<StatCard[]>(() => [
  {
    label: '活跃录制',
    value: String(dashboard.value?.active_count ?? 0),
    sublines: [`线程池 ${dashboard.value?.active_count ?? 0}/${dashboard.value?.pool_size ?? 0}`],
    gradient: 'from-blue-500 to-blue-600',
    accent: 'text-blue-100',
    iconPath:
      'm15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z',
  },
  {
    label: '转码队列',
    value: String(dashboard.value?.transcode.queue_length ?? 0),
    sublines: [
      `处理中 ${dashboard.value?.transcode.processing ?? 0} / 并发 ${
        dashboard.value?.transcode.concurrency ?? 0
      }`,
    ],
    gradient: 'from-amber-500 to-amber-600',
    accent: 'text-amber-100',
    iconPath:
      'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z',
  },
  {
    label: '轮询状态',
    value: hasPolling.value ? String(polling.value.total_polled) : '--',
    sublines: hasPolling.value
      ? [`直播中 ${polling.value.currently_live} / 已配置 ${polling.value.total_rooms}`]
      : [],
    gradient: 'from-indigo-500 to-indigo-600',
    accent: 'text-indigo-100',
    iconPath: 'M6 20.25h12m-7.5-3v3m3-3v3m-10.125-3h17.25V4.875H3.375v12.375Z',
  },
  {
    label: '弹幕状态',
    value: hasDanmaku.value ? String(danmaku.value.active_captures) : '--',
    sublines: hasDanmaku.value
      ? [
          `采集 ${danmaku.value.active_captures}`,
          `压制等待 ${danmaku.value.burn_queue.queue_length} / 处理中 ${danmaku.value.burn_queue.processing}`,
        ]
      : [],
    gradient: 'from-cyan-500 to-cyan-600',
    accent: 'text-cyan-100',
    iconPath:
      'M7.5 8.25h9m-9 3H12m-7.5 3.75V5.25A2.25 2.25 0 0 1 6.75 3h10.5a2.25 2.25 0 0 1 2.25 2.25v6.75a2.25 2.25 0 0 1-2.25 2.25H9.75L4.5 18Z',
  },
  {
    label: '今日录制',
    value: hasSummary.value ? String(summary.value.sessions_today) : '--',
    sublines: hasSummary.value ? [formatBytes(summary.value.sessions_today_total_size)] : [],
    gradient: 'from-teal-500 to-teal-600',
    accent: 'text-teal-100',
    iconPath: 'M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12',
    warning:
      hasSummary.value && summary.value.interrupted_today > 0
        ? `中断 ${summary.value.interrupted_today}`
        : undefined,
  },
  {
    label: '今日投稿',
    value: hasSummary.value ? String(summary.value.uploads_today) : '--',
    sublines: hasSummary.value ? [`失败 ${summary.value.uploads_failed_today}`] : [],
    gradient: 'from-rose-500 to-rose-600',
    accent: 'text-rose-100',
    iconPath:
      'M6 12 3.269 3.126A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.876L6 12Zm0 0h7.5',
  },
  {
    label: '回放待处理',
    value: hasSummary.value ? String(summary.value.replay_pending) : '--',
    sublines: [
      `队列 ${dashboard.value?.replay?.queue_length ?? 0} / 处理中 ${dashboard.value?.replay?.processing ?? 0}/${dashboard.value?.replay?.concurrency ?? 1}`,
    ],
    gradient: 'from-purple-500 to-purple-600',
    accent: 'text-purple-100',
    iconPath: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  },
  {
    label: '今日回放',
    value: hasSummary.value ? String(summary.value.replay_completed_today) : '--',
    sublines: hasSummary.value ? [formatBytes(summary.value.replay_completed_today_size)] : [],
    gradient: 'from-emerald-500 to-emerald-600',
    accent: 'text-emerald-100',
    iconPath: 'M5.25 5.653c0-.856.917-1.402 1.669-.981l11.662 6.847a1.121 1.121 0 0 1 0 1.948l-11.662 6.847a1.121 1.121 0 0 1-1.669-.981V5.653Z',
  },
])

async function fetchDashboard() {
  try {
    dashboardError.value = ''
    const statusRes = await apiGet<DashboardStatus>('/api/dashboard/status')
    dashboard.value = statusRes.data
  } catch (err) {
    console.error('[Dashboard] 仪表盘加载失败:', err)
    dashboardError.value = err instanceof Error ? err.message : '仪表盘加载失败'
  } finally {
    loading.value = false
  }
}

function startRefresh() {
  stopRefresh()
  refreshTimer = setInterval(fetchDashboard, 5000)
}

function stopRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

function toggleRefresh() {
  autoRefresh.value = !autoRefresh.value
  if (autoRefresh.value) {
    startRefresh()
  } else {
    stopRefresh()
  }
}

function formatDuration(d: string | null | undefined): string {
  if (!d) return '-'
  const target = new Date(d)
  if (isNaN(target.getTime())) return '-'
  const sec = Math.floor((Date.now() - target.getTime()) / 1000)
  if (sec < 0) return '-'
  if (sec < 60) return sec + ' 秒'
  if (sec < 3600) return Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h + ' 时 ' + m + ' 分'
}

function statusText(value: boolean | null) {
  if (!appStore.healthLoaded || value === null) return '检查中'
  return value ? '正常' : '异常'
}

function statusDotClass(value: boolean | null) {
  if (!appStore.healthLoaded || value === null) return 'bg-gray-400'
  return value ? 'bg-green-500' : 'bg-red-500'
}

onMounted(() => {
  fetchDashboard().then(() => {
    if (autoRefresh.value) startRefresh()
  })
})

onUnmounted(() => {
  stopRefresh()
})
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6 gap-3 flex-wrap">
      <h1 class="text-2xl font-bold text-gray-900">仪表盘</h1>
      <div class="flex items-center gap-3">
        <span
          class="text-xs font-medium px-2.5 py-1 rounded-full"
          :class="autoRefresh ? 'bg-gray-100 text-gray-600' : 'bg-yellow-100 text-yellow-700'"
        >
          {{ autoRefresh ? '自动刷新: 5s' : '已暂停' }}
        </span>
        <button
          class="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
          @click="toggleRefresh"
        >
          {{ autoRefresh ? '暂停刷新' : '恢复刷新' }}
        </button>
      </div>
    </div>

    <div
      v-if="dashboardError"
      class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      <div class="flex items-center justify-between gap-3">
        <span>{{ dashboardError }}</span>
        <button
          class="px-3 py-1 text-xs font-medium rounded-lg border border-red-200 text-red-700 hover:bg-red-100 transition-colors"
          @click="fetchDashboard"
        >
          重试
        </button>
      </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
      <div
        v-for="card in statCards"
        :key="card.label"
        class="rounded-xl bg-gradient-to-br text-white p-5 shadow-sm min-h-[136px]"
        :class="card.gradient"
      >
        <div v-if="loading" class="animate-pulse">
          <div class="h-3 w-20 rounded bg-white/30 mb-4"></div>
          <div class="h-8 w-14 rounded bg-white/30 mb-3"></div>
          <div class="h-3 w-28 rounded bg-white/20"></div>
        </div>

        <div v-else class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="text-sm font-medium" :class="card.accent">{{ card.label }}</div>
            <div class="text-3xl font-bold mt-1">{{ card.value }}</div>
            <div class="mt-1 space-y-0.5">
              <div v-for="line in card.sublines" :key="line" class="text-xs text-white/80">
                {{ line }}
              </div>
              <div v-if="card.warning" class="text-xs font-semibold text-yellow-100">
                {{ card.warning }}
              </div>
            </div>
          </div>
          <div class="w-12 h-12 rounded-lg bg-white/20 flex items-center justify-center shrink-0">
            <svg
              class="w-6 h-6"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" :d="card.iconPath" />
            </svg>
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1.5fr)_minmax(360px,0.9fr)] gap-6">
      <section class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div class="px-6 py-4 border-b border-gray-200">
          <h2 class="text-lg font-semibold text-gray-900">活跃录制进程</h2>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 border-b border-gray-200">
              <tr>
                <th class="px-6 py-3 text-left font-medium text-gray-500">直播间</th>
                <th class="px-6 py-3 text-left font-medium text-gray-500">Session ID</th>
                <th class="px-6 py-3 text-left font-medium text-gray-500">PID</th>
                <th class="px-6 py-3 text-left font-medium text-gray-500">开始时间</th>
                <th class="px-6 py-3 text-left font-medium text-gray-500">下载引擎</th>
                <th class="px-6 py-3 text-left font-medium text-gray-500">已录制时长</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-if="loading">
                <td colspan="6" class="px-6 py-10">
                  <div class="space-y-3 animate-pulse">
                    <div class="h-3 rounded bg-gray-100 w-2/3"></div>
                    <div class="h-3 rounded bg-gray-100 w-1/2"></div>
                  </div>
                </td>
              </tr>
              <tr v-else-if="activeRecordings.length === 0">
                <td colspan="6" class="px-6 py-12 text-center text-gray-400">
                  <svg
                    class="w-10 h-10 mx-auto mb-2 text-gray-300"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
                    />
                  </svg>
                  <div class="text-sm font-medium text-gray-500">暂无活跃录制</div>
                  <div v-if="hasPolling" class="text-xs text-gray-400 mt-1">
                    {{ polling.total_polled }} 个房间正在监控中，{{ polling.currently_live }}
                    个主播在线
                  </div>
                </td>
              </tr>
              <template v-else>
                <tr
                  v-for="rec in activeRecordings"
                  :key="`${rec.room_url}:${rec.session_id}`"
                  class="hover:bg-gray-50 transition-colors"
                >
                  <td class="px-6 py-3">
                    <div class="flex items-center gap-2">
                      <span class="relative flex h-2.5 w-2.5">
                        <span
                          class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"
                        ></span>
                        <span
                          class="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"
                        ></span>
                      </span>
                      <div>
                        <div class="font-medium text-gray-900">
                          {{ rec.room_name || rec.room_url }}
                        </div>
                        <a
                          :href="rec.room_url"
                          target="_blank"
                          class="text-xs text-gray-400 hover:text-brand-600 truncate block max-w-[280px]"
                        >
                          {{ rec.room_url }}
                        </a>
                      </div>
                    </div>
                  </td>
                  <td class="px-6 py-3">
                    <router-link
                      :to="{ path: '/sessions', query: { room_url: rec.room_url } }"
                      class="text-brand-600 hover:text-brand-700 font-mono text-xs"
                    >
                      #{{ rec.session_id }}
                    </router-link>
                  </td>
                  <td class="px-6 py-3 font-mono text-xs text-gray-500">{{ rec.pid }}</td>
                  <td class="px-6 py-3 text-gray-500 text-xs">{{ $formatTime(rec.started_at) }}</td>
                  <td class="px-6 py-3">
                    <span
                      class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700"
                    >
                      {{ rec.downloader }}
                    </span>
                  </td>
                  <td class="px-6 py-3 text-gray-500 text-xs">
                    {{ formatDuration(rec.started_at) }}
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>

      <ActivityTimeline
        :activities="recentActivity"
        :loading="loading"
        :error="dashboardError"
        @retry="fetchDashboard"
      />
    </div>

    <section class="mt-6 bg-white rounded-xl border border-gray-200 shadow-sm px-6 py-4">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div class="flex items-center gap-2">
          <span
            class="inline-block w-2 h-2 rounded-full"
            :class="statusDotClass(appStore.dbHealthy)"
          ></span>
          <span class="text-gray-500">DB:</span>
          <span class="font-medium text-gray-700">{{ statusText(appStore.dbHealthy) }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span
            class="inline-block w-2 h-2 rounded-full"
            :class="statusDotClass(appStore.redisHealthy)"
          ></span>
          <span class="text-gray-500">Redis:</span>
          <span class="font-medium text-gray-700">{{ statusText(appStore.redisHealthy) }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-gray-500">孤文件:</span>
          <span
            class="font-medium"
            :class="summary.orphaned_files > 0 ? 'text-amber-600' : 'text-gray-700'"
          >
            {{ hasSummary ? summary.orphaned_files : '--' }}
          </span>
        </div>
      </div>
    </section>
  </div>
</template>
