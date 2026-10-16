<script setup lang="ts">
/**
 * AI 弹幕分析 - 记录列表 + 行内详情（高光时间轴）
 * ADR-017：统计高光 + LLM 总结，报告 HTML 走鉴权 /report 端点新窗口打开
 */
import { ref, computed, onMounted } from 'vue'
import { apiGet, apiPost, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import Pagination from '@/components/Pagination.vue'

const toast = useToast()

interface AnalysisRow {
  id: number
  session_id: number
  status: string
  summary: string | null
  model: string | null
  llm_ok: boolean
  llm_error: string | null
  threshold_mode: string | null
  elapsed_s: string | number | null
  created_at: string
  updated_at: string
  comment_count: string | null
  span_minutes: string | null
  intervals_total: string | null
  room_url: string | null
  room_name: string | null
}

interface Highlight {
  start_ms: number
  end_ms: number
  score: number
  peak_weighted: number
  label?: string
  reason?: string
  samples?: string[]
}

interface AnalysisDetail extends AnalysisRow {
  highlights: Highlight[] | null
  stats: Record<string, unknown> | null
}

const records = ref<AnalysisRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(true)
const statusFilter = ref('')
const triggerSid = ref('')

const detailMap = ref<Record<number, AnalysisDetail>>({})
const expanded = ref<number | null>(null)
const detailLoading = ref(false)

const STATUS_LABELS: Record<string, string> = {
  pending: '排队中',
  running: '分析中',
  completed: '已完成',
  failed: '失败',
  no_danmaku: '无弹幕',
}

function statusStyle(status: string) {
  if (status === 'completed') return 'bg-green-100 text-green-700'
  if (status === 'failed') return 'bg-red-100 text-red-700'
  if (status === 'running' || status === 'pending') return 'bg-blue-100 text-blue-700'
  if (status === 'no_danmaku') return 'bg-gray-100 text-gray-600'
  return 'bg-gray-100 text-gray-600'
}

function fmtHMS(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

const completedCount = computed(() => records.value.filter((r) => r.status === 'completed').length)
const runningCount = computed(
  () => records.value.filter((r) => r.status === 'running' || r.status === 'pending').length,
)
const failedCount = computed(() => records.value.filter((r) => r.status === 'failed').length)
const llmOkCount = computed(() => records.value.filter((r) => r.llm_ok).length)

async function loadData() {
  loading.value = true
  try {
    const qs = new URLSearchParams({ limit: String(pageSize), page: String(page.value) })
    if (statusFilter.value) qs.set('status', statusFilter.value)
    const res = await apiGet<AnalysisRow[]>(`/api/danmaku-analysis?${qs.toString()}`)
    records.value = res.data ?? []
    total.value = res.total ?? 0
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '加载失败')
  } finally {
    loading.value = false
  }
}

function handlePageChange(p: number) {
  page.value = p
  loadData()
}

function onFilterChange() {
  page.value = 1
  loadData()
}

async function toggleDetail(sid: number) {
  if (expanded.value === sid) {
    expanded.value = null
    return
  }
  expanded.value = sid
  if (detailMap.value[sid]) return
  detailLoading.value = true
  try {
    const res = await apiGet<AnalysisDetail>(`/api/danmaku-analysis/${sid}`)
    detailMap.value = { ...detailMap.value, [sid]: res.data }
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '详情加载失败')
    expanded.value = null
  } finally {
    detailLoading.value = false
  }
}

async function triggerAnalysis(sid: number, force = false) {
  try {
    await apiPost(`/api/danmaku-analysis/${sid}${force ? '?force=true' : ''}`)
    toast.success(`会话 ${sid} 已入队分析`)
    loadData()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '触发失败')
  }
}

async function handleTriggerInput() {
  const sid = parseInt(triggerSid.value, 10)
  if (!Number.isInteger(sid) || sid <= 0) {
    toast.error('请输入有效的会话 ID')
    return
  }
  await triggerAnalysis(sid)
  triggerSid.value = ''
}

function openReport(sid: number) {
  window.open(`/api/danmaku-analysis/${sid}/report`, '_blank')
}

onMounted(loadData)
</script>

<template>
  <div>
    <div class="mb-6 flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">AI 弹幕分析</h1>
        <p class="text-sm text-gray-500 mt-1">快手弹幕统计高光 + LLM 总结（ADR-017）</p>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-model="triggerSid"
          type="text"
          placeholder="会话 ID"
          class="px-3 py-1.5 text-sm border border-gray-300 rounded-lg w-24 focus:outline-none focus:ring-2 focus:ring-brand-500"
          @keyup.enter="handleTriggerInput"
        />
        <button
          class="px-3 py-1.5 text-sm rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition-colors"
          @click="handleTriggerInput"
        >
          分析会话
        </button>
      </div>
    </div>

    <!-- Stats bar -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      <div class="bg-white rounded-xl border border-gray-200 p-4 text-center shadow-sm">
        <div class="text-2xl font-bold text-green-600">{{ completedCount }}</div>
        <div class="text-xs text-gray-500 mt-1">已完成（本页）</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 text-center shadow-sm">
        <div class="text-2xl font-bold text-blue-600">{{ runningCount }}</div>
        <div class="text-xs text-gray-500 mt-1">进行中（本页）</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 text-center shadow-sm">
        <div class="text-2xl font-bold text-red-600">{{ failedCount }}</div>
        <div class="text-xs text-gray-500 mt-1">失败（本页）</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 text-center shadow-sm">
        <div class="text-2xl font-bold text-purple-600">{{ llmOkCount }}</div>
        <div class="text-xs text-gray-500 mt-1">LLM 成功（本页）</div>
      </div>
    </div>

    <!-- Filter -->
    <div class="mb-4 flex items-center gap-3">
      <select
        v-model="statusFilter"
        class="px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white"
        @change="onFilterChange"
      >
        <option value="">全部状态</option>
        <option value="completed">已完成</option>
        <option value="running">分析中</option>
        <option value="failed">失败</option>
        <option value="no_danmaku">无弹幕</option>
      </select>
      <span class="text-xs text-gray-400">共 {{ total }} 条</span>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center py-12">
      <div
        class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"
      />
      <span class="text-sm text-gray-500">加载中...</span>
    </div>

    <template v-else>
      <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 border-b border-gray-200">
              <tr>
                <th class="px-4 py-3 text-left font-medium text-gray-500 w-20">会话</th>
                <th class="px-4 py-3 text-left font-medium text-gray-500">直播间</th>
                <th class="px-4 py-3 text-left font-medium text-gray-500 w-20">状态</th>
                <th class="px-4 py-3 text-right font-medium text-gray-500 w-20">弹幕</th>
                <th class="px-4 py-3 text-right font-medium text-gray-500 w-20">时长(分)</th>
                <th class="px-4 py-3 text-right font-medium text-gray-500 w-16">高光</th>
                <th class="px-4 py-3 text-left font-medium text-gray-500">一句话总结</th>
                <th class="px-4 py-3 text-left font-medium text-gray-500 w-36">时间</th>
                <th class="px-4 py-3 text-right font-medium text-gray-500 w-40">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-if="!records.length">
                <td colspan="9" class="px-4 py-12 text-center text-gray-400">暂无分析记录</td>
              </tr>
              <template v-for="r in records" :key="r.id">
                <tr
                  class="hover:bg-gray-50 transition-colors cursor-pointer"
                  @click="toggleDetail(r.session_id)"
                >
                  <td class="px-4 py-3 font-mono text-xs text-gray-500">#{{ r.session_id }}</td>
                  <td class="px-4 py-3">
                    <div class="text-gray-700 truncate max-w-[160px]">{{ r.room_name || '-' }}</div>
                  </td>
                  <td class="px-4 py-3">
                    <span
                      class="px-2 py-0.5 text-xs font-medium rounded"
                      :class="statusStyle(r.status)"
                      >{{ STATUS_LABELS[r.status] || r.status }}</span
                    >
                  </td>
                  <td class="px-4 py-3 text-right text-gray-600">{{ r.comment_count ?? '-' }}</td>
                  <td class="px-4 py-3 text-right text-gray-600">{{ r.span_minutes ?? '-' }}</td>
                  <td class="px-4 py-3 text-right text-gray-600">{{ r.intervals_total ?? '-' }}</td>
                  <td class="px-4 py-3 text-gray-500 text-xs max-w-[260px]">
                    <span class="truncate block">{{
                      r.summary || (r.llm_ok ? '' : '（未启用 LLM）')
                    }}</span>
                  </td>
                  <td class="px-4 py-3 text-xs text-gray-500">{{ $formatTime(r.created_at) }}</td>
                  <td class="px-4 py-3 text-right space-x-1.5 whitespace-nowrap">
                    <button
                      v-if="['completed', 'no_danmaku'].includes(r.status)"
                      class="px-2 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors"
                      @click.stop="openReport(r.session_id)"
                    >
                      报告
                    </button>
                    <button
                      v-if="r.status === 'completed'"
                      class="px-2 py-1 text-xs rounded border border-amber-300 text-amber-700 hover:bg-amber-50 transition-colors"
                      @click.stop="triggerAnalysis(r.session_id, true)"
                    >
                      重算
                    </button>
                    <button
                      v-else-if="r.status !== 'running' && r.status !== 'pending'"
                      class="px-2 py-1 text-xs rounded border border-brand-300 text-brand-700 hover:bg-brand-50 transition-colors"
                      @click.stop="triggerAnalysis(r.session_id)"
                    >
                      分析
                    </button>
                  </td>
                </tr>
                <tr v-if="expanded === r.session_id">
                  <td colspan="9" class="px-4 py-4 bg-gray-50">
                    <div
                      v-if="detailLoading && !detailMap[r.session_id]"
                      class="text-sm text-gray-400"
                    >
                      加载中...
                    </div>
                    <div v-else-if="detailMap[r.session_id]" class="space-y-3">
                      <div v-if="detailMap[r.session_id].summary" class="text-sm text-gray-700">
                        <span class="font-medium">总结：</span>{{ detailMap[r.session_id].summary }}
                        <span class="text-xs text-gray-400 ml-2"
                          >模型 {{ detailMap[r.session_id].model || '-' }}</span
                        >
                      </div>
                      <div
                        v-else-if="detailMap[r.session_id].llm_error"
                        class="text-xs text-red-500"
                      >
                        LLM 未成功：{{ detailMap[r.session_id].llm_error }}
                      </div>
                      <div class="text-xs text-gray-500">
                        阈值模式 {{ detailMap[r.session_id].threshold_mode || '-' }} · 耗时
                        {{ detailMap[r.session_id].elapsed_s ?? '-' }}s
                      </div>
                      <div
                        v-if="(detailMap[r.session_id].highlights || []).length"
                        class="space-y-2"
                      >
                        <div
                          v-for="(h, i) in detailMap[r.session_id].highlights || []"
                          :key="i"
                          class="bg-white rounded-lg border border-gray-200 p-3"
                        >
                          <div class="flex items-center gap-2 flex-wrap">
                            <span
                              class="text-xs font-mono text-brand-700 bg-brand-50 px-1.5 py-0.5 rounded"
                            >
                              {{ fmtHMS(h.start_ms) }} → {{ fmtHMS(h.end_ms) }}
                            </span>
                            <span v-if="h.label" class="text-sm font-medium text-gray-800">{{
                              h.label
                            }}</span>
                            <span class="text-xs text-gray-400"
                              >峰值加权 {{ h.peak_weighted }}</span
                            >
                          </div>
                          <p v-if="h.reason" class="text-xs text-gray-600 mt-1">{{ h.reason }}</p>
                          <div
                            v-if="h.samples && h.samples.length"
                            class="flex flex-wrap gap-1 mt-2"
                          >
                            <span
                              v-for="(s, si) in h.samples"
                              :key="si"
                              class="px-1.5 py-0.5 text-xs bg-gray-100 text-gray-600 rounded max-w-[200px] truncate"
                              :title="s"
                              >{{ s }}</span
                            >
                          </div>
                        </div>
                      </div>
                      <p v-else class="text-xs text-gray-400">未检出高光区间</p>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <div class="px-4 pb-4">
          <Pagination
            :current="page"
            :total="total"
            :page-size="pageSize"
            @change="handlePageChange"
          />
        </div>
      </div>
    </template>
  </div>
</template>
