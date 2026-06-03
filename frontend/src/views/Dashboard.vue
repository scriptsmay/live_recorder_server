<script setup lang="ts">
/**
 * 仪表盘 - 系统概览和活跃录制状态
 *
 * - 4 个统计卡片（活跃录制、转码队列、直播间总数、转码并发）
 * - 活跃录制表格
 * - 5 秒自动刷新（可暂停）
 * - 健康状态指示
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { apiGet } from '@/utils/api'
import type { DashboardStatus } from '@/types/api'

// --- 响应式状态 ---
const loading = ref(true)
const dashboard = ref<DashboardStatus | null>(null)
const roomTotal = ref(0)
const healthOk = ref(true)
const appVersion = ref('')
const autoRefresh = ref(true)
let refreshTimer: ReturnType<typeof setInterval> | null = null

// --- 数据加载 ---
async function fetchDashboard() {
  try {
    // /api/rooms 返回 { status, data: Room[], total } —— total 在顶层
    // /api/health 可能返回 503，需要用 fetch 直接读取响应体
    const [statusRes, roomsRes, healthRaw] = await Promise.all([
      apiGet<DashboardStatus>('/api/dashboard/status'),
      apiGet<unknown>('/api/rooms'),
      fetch('/api/health').then((r) => r.json()),
    ])
    dashboard.value = statusRes.data

    const roomsBody = roomsRes as unknown as { total?: number }
    roomTotal.value = roomsBody.total ?? 0

    healthOk.value = healthRaw.ok === true
    appVersion.value = healthRaw.version ?? ''
  } catch (err) {
    console.error('仪表盘加载失败:', err)
  } finally {
    loading.value = false
  }
}

// --- 自动刷新 ---
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

// --- 工具函数 ---
function formatDate(d: string | null | undefined): string {
  if (!d) return '-'
  const date = new Date(d)
  if (isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN')
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

// --- 生命周期 ---
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
    <!-- 标题栏 -->
    <div class="flex items-center justify-between mb-6">
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

    <!-- 加载态 -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div>
      <span class="ml-3 text-gray-500">加载中...</span>
    </div>

    <template v-else>
      <!-- 统计卡片 -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <!-- 活跃录制 -->
        <div
          class="rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 text-white p-5 shadow-sm"
        >
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-medium text-blue-100">活跃录制</div>
              <div class="text-3xl font-bold mt-1">{{ dashboard?.active_count ?? 0 }}</div>
              <div class="text-xs text-blue-200 mt-1">
                线程池 {{ dashboard?.active_count ?? 0 }}/{{ dashboard?.pool_size ?? 0 }}
              </div>
            </div>
            <div class="w-12 h-12 rounded-lg bg-white/20 flex items-center justify-center">
              <svg
                class="w-6 h-6"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
                />
              </svg>
            </div>
          </div>
        </div>

        <!-- 转码队列 -->
        <div
          class="rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 text-white p-5 shadow-sm"
        >
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-medium text-amber-100">转码队列</div>
              <div class="text-3xl font-bold mt-1">
                {{ dashboard?.transcode.queue_length ?? 0 }}
              </div>
              <div class="text-xs text-amber-200 mt-1">等待处理</div>
            </div>
            <div class="w-12 h-12 rounded-lg bg-white/20 flex items-center justify-center">
              <svg
                class="w-6 h-6"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
                />
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                />
              </svg>
            </div>
          </div>
        </div>

        <!-- 直播间总数 -->
        <div
          class="rounded-xl bg-gradient-to-br from-green-500 to-green-600 text-white p-5 shadow-sm"
        >
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-medium text-green-100">直播间总数</div>
              <div class="text-3xl font-bold mt-1">{{ roomTotal }}</div>
              <div class="text-xs text-green-200 mt-1">已配置</div>
            </div>
            <div class="w-12 h-12 rounded-lg bg-white/20 flex items-center justify-center">
              <svg
                class="w-6 h-6"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M6 20.25h12m-7.5-3v3m3-3v3m-10.125-3h17.25c.621 0 1.125-.504 1.125-1.125V4.875c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125Z"
                />
              </svg>
            </div>
          </div>
        </div>

        <!-- 转码并发 -->
        <div
          class="rounded-xl bg-gradient-to-br from-purple-500 to-purple-600 text-white p-5 shadow-sm"
        >
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm font-medium text-purple-100">转码并发</div>
              <div class="text-3xl font-bold mt-1">{{ dashboard?.transcode.concurrency ?? 0 }}</div>
              <div class="text-xs text-purple-200 mt-1">
                处理中 {{ dashboard?.transcode.processing ?? 0 }}
              </div>
            </div>
            <div class="w-12 h-12 rounded-lg bg-white/20 flex items-center justify-center">
              <svg
                class="w-6 h-6"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z"
                />
              </svg>
            </div>
          </div>
        </div>
      </div>

      <!-- 活跃录制表格 -->
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
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
              <tr v-if="!dashboard?.active_recordings?.length">
                <td colspan="6" class="px-6 py-10 text-center text-gray-400">
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
                  当前无活跃录制
                </td>
              </tr>
              <tr
                v-for="rec in dashboard?.active_recordings ?? []"
                :key="rec.session_id"
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
                <td class="px-6 py-3 text-gray-500 text-xs">{{ formatDate(rec.started_at) }}</td>
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
            </tbody>
          </table>
        </div>
      </div>

      <!-- 底部：健康状态 + 版本 -->
      <div class="mt-4 flex items-center justify-end gap-4 text-xs text-gray-400">
        <div class="flex items-center gap-1.5">
          <span
            class="inline-block w-2 h-2 rounded-full"
            :class="healthOk ? 'bg-green-500' : 'bg-red-500'"
          ></span>
          <span>{{ healthOk ? '系统正常' : '系统异常' }}</span>
        </div>
        <span v-if="appVersion">v{{ appVersion }}</span>
        <router-link to="/logs" class="hover:text-brand-600 transition-colors">
          查看完整日志
        </router-link>
      </div>
    </template>
  </div>
</template>
