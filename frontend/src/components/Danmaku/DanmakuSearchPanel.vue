<script setup lang="ts">
/**
 * DanmakuSearchPanel - 弹幕搜索面板（可复用）
 *
 * 自包含搜索状态，传入 sessionId 即可使用。
 * 用于 SessionDanmaku 页面（内联）和弹幕工具箱（Modal 内）。
 *
 * 设计：Linear Aesthetic —— 图标化输入框 + 短语高亮 + 超细描边结果表；
 * compact 模式隐藏 UID / 采集时间列并压缩间距。
 */
import { ref, computed, watch } from 'vue'
import { apiGet } from '@/utils/api'
import { useToast } from '@/utils/toast'

const props = withDefaults(
  defineProps<{
    sessionId: number | string
    /** 紧凑模式：隐藏 UID 列，更紧凑的间距 */
    compact?: boolean
  }>(),
  { compact: false },
)

const toast = useToast()

interface DanmakuSearchResult {
  ts_ms: number
  ts_abs_ms?: number
  ts_str: string
  text: string
  username: string
  user_id: string
}

const keyword = ref('')
const results = ref<DanmakuSearchResult[]>([])
const total = ref(0)
const offset = ref(0)
const limit = 50
const searching = ref(false)
const searched = ref(false)
const searchInputRef = ref<HTMLInputElement | null>(null)

const pageIndex = computed(() => Math.floor(offset.value / limit) + 1)
const pageTotal = computed(() => Math.max(1, Math.ceil(total.value / limit)))
const rangeText = computed(() => {
  if (total.value === 0) return '0 条'
  return `第 ${offset.value + 1}-${Math.min(offset.value + results.value.length, total.value)} 条`
})

async function doSearch(newOffset = 0) {
  if (!props.sessionId) return
  // 允许keyword为空显示全部弹幕数据
  offset.value = newOffset
  searching.value = true
  searched.value = true
  try {
    const params = new URLSearchParams({
      session_id: String(props.sessionId),
      keyword: keyword.value.trim(),
      limit: String(limit),
      offset: String(offset.value),
    })
    const res = await apiGet<DanmakuSearchResult[]>(`/api/danmaku/search?${params}`)
    results.value = res.data ?? []
    total.value = (res as unknown as { total: number }).total ?? 0
  } catch (err) {
    toast.error('弹幕搜索失败: ' + (err instanceof Error ? err.message : '未知错误'))
    results.value = []
    total.value = 0
  } finally {
    searching.value = false
  }
}

function handleSearch() {
  doSearch(0)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') doSearch(0)
}

function clearKeyword() {
  keyword.value = ''
  searchInputRef.value?.focus()
}

function prevPage() {
  doSearch(Math.max(0, offset.value - limit))
}

function nextPage() {
  doSearch(offset.value + limit)
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlightKeyword(text: string): string {
  const kw = keyword.value.trim()
  if (!kw) return escapeHtml(text)
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return escapeHtml(text).replace(
    new RegExp(`(${escaped})`, 'gi'),
    '<mark class="rounded bg-brand-500/25 px-0.5 font-medium text-gray-900">$1</mark>',
  )
}

function reset() {
  keyword.value = ''
  results.value = []
  total.value = 0
  offset.value = 0
  searched.value = false
  searchInputRef.value?.focus()
}

defineExpose({ reset })

// sessionId 存在时自动加载（覆盖初始挂载和切换会话场景）
watch(
  () => props.sessionId,
  (id) => {
    if (id) doSearch(0)
  },
  { immediate: true },
)
</script>

<template>
  <div>
    <!-- 搜索栏 -->
    <div class="flex gap-2" :class="compact ? 'mb-2.5' : 'mb-4'">
      <div class="relative flex-1">
        <svg
          class="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
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
        <input
          ref="searchInputRef"
          v-model="keyword"
          type="text"
          class="w-full rounded-lg border border-gray-300 bg-white py-1.5 pl-8 pr-8 text-sm text-gray-900 outline-none transition-all placeholder:text-gray-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/50"
          placeholder="搜索弹幕内容 / 用户名 / UID"
          @keydown="handleKeydown"
        />
        <button
          v-if="keyword"
          class="absolute right-2 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          title="清空关键词"
          @click="clearKeyword"
        >
          <svg
            class="h-3 w-3"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <button
        class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white transition-all hover:bg-brand-700 glow-accent disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="searching"
        @click="handleSearch"
      >
        <svg v-if="searching" class="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
        </svg>
        {{ searching ? '搜索中' : '搜索' }}
      </button>
    </div>

    <!-- 初始状态 -->
    <div v-if="!searched && !searching" class="flex flex-col items-center gap-2 py-8 text-center">
      <span
        class="flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 text-gray-300"
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
            d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
          />
        </svg>
      </span>
      <p class="text-sm text-gray-400">输入关键词搜索弹幕，留空可浏览全部</p>
    </div>

    <!-- 加载中 -->
    <div v-else-if="searching" class="flex items-center justify-center gap-2 py-8">
      <div
        class="h-4 w-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"
      />
      <span class="text-sm text-gray-500">搜索中...</span>
    </div>

    <!-- 无结果 -->
    <div v-else-if="results.length === 0" class="py-8 text-center">
      <p class="text-sm text-gray-400">无匹配弹幕</p>
      <p v-if="keyword.trim()" class="mt-1 text-xs text-gray-400">试试更短的关键词或更换筛选</p>
    </div>

    <!-- 结果 -->
    <template v-else>
      <div
        class="flex flex-wrap items-center gap-x-3 gap-y-1"
        :class="compact ? 'mb-1.5' : 'mb-2.5'"
      >
        <span class="text-xs text-gray-500">
          匹配 <span class="font-medium tabular-nums text-gray-900">{{ total }}</span> 条
        </span>
        <span class="text-xs tabular-nums text-gray-400">{{ rangeText }}</span>
      </div>

      <div class="overflow-x-auto rounded-lg border border-gray-200/70">
        <table class="w-full" :class="compact ? 'text-xs' : 'text-sm'">
          <thead>
            <tr
              class="border-b border-gray-200/70 bg-gray-50/60 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400"
            >
              <th class="w-20 px-3 py-2">时间</th>
              <th class="w-32 px-3 py-2">用户</th>
              <th v-if="!compact" class="w-32 px-3 py-2">UID</th>
              <th class="px-3 py-2">弹幕内容</th>
              <th v-if="!compact" class="w-40 px-3 py-2">采集时间</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100/80">
            <tr v-for="(d, i) in results" :key="i" class="transition-colors hover:bg-gray-50/70">
              <td
                class="whitespace-nowrap px-3 py-1.5 font-mono text-xs tabular-nums text-gray-400"
              >
                {{ d.ts_str || '—' }}
              </td>
              <td
                class="max-w-[140px] truncate px-3 py-1.5 text-xs font-medium text-gray-700"
                :title="d.username"
              >
                {{ d.username || '—' }}
              </td>
              <td v-if="!compact" class="px-3 py-1.5 font-mono text-xs text-gray-500">
                {{ d.user_id || '—' }}
              </td>
              <td
                class="px-3 py-1.5 text-gray-800"
                :class="compact ? 'text-xs' : 'text-sm'"
                v-html="highlightKeyword(d.text)"
              />
              <td
                v-if="!compact"
                class="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums text-gray-400"
              >
                {{ $formatTime(d.ts_abs_ms) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div v-if="total > limit" class="mt-3 flex items-center justify-between gap-2">
        <span class="text-xs tabular-nums text-gray-400">{{ pageIndex }} / {{ pageTotal }} 页</span>
        <div class="flex items-center gap-1.5">
          <button
            class="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="offset <= 0"
            @click="prevPage"
          >
            <svg
              class="h-3 w-3"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M15.75 19.5 8.25 12l7.5-7.5"
              />
            </svg>
            上一页
          </button>
          <button
            class="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="offset + limit >= total"
            @click="nextPage"
          >
            下一页
            <svg
              class="h-3 w-3"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
