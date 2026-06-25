<script setup lang="ts">
/**
 * DanmakuSearchPanel - 弹幕搜索面板（可复用）
 *
 * 自包含搜索状态，传入 sessionId 即可使用。
 * 用于 SessionDanmaku 页面（内联）和弹幕工具箱（Modal 内）。
 */
import { ref, watch } from 'vue'
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
    '<mark class="bg-yellow-200 text-yellow-900 rounded px-0.5">$1</mark>',
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
    <div class="flex gap-2" :class="compact ? 'mb-2' : 'mb-4'">
      <input
        ref="searchInputRef"
        v-model="keyword"
        type="text"
        class="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all"
        placeholder="搜索弹幕内容/用户名/UID..."
        @keydown="handleKeydown"
      />
      <button
        class="px-4 py-1.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
        :disabled="searching"
        @click="handleSearch"
      >
        {{ searching ? '搜索中...' : '搜索' }}
      </button>
    </div>

    <!-- 初始状态 -->
    <div v-if="!searched && !searching" class="text-center py-6 text-sm text-gray-400">
      输入关键词搜索弹幕
    </div>

    <!-- 加载中 -->
    <div v-else-if="searching" class="flex items-center justify-center gap-2 py-6">
      <div
        class="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"
      />
      <span class="text-sm text-gray-500">搜索中...</span>
    </div>

    <!-- 无结果 -->
    <div v-else-if="results.length === 0" class="text-center py-6 text-sm text-gray-400">
      无匹配弹幕
    </div>

    <!-- 结果 -->
    <template v-else>
      <div class="text-xs text-gray-400" :class="compact ? 'mb-1' : 'mb-2'">
        共 {{ total }} 条匹配 (显示 {{ offset + 1 }}-{{ Math.min(offset + results.length, total) }})
      </div>
      <div class="overflow-x-auto">
        <table class="w-full" :class="compact ? 'text-xs' : 'text-sm'">
          <thead>
            <tr class="text-left text-gray-500 border-b border-gray-200">
              <th class="pb-2 font-medium w-20">时间</th>
              <th class="pb-2 font-medium w-32">用户</th>
              <th v-if="!compact" class="pb-2 font-medium w-32">UID</th>
              <th class="pb-2 font-medium">弹幕内容</th>
              <th v-if="!compact" class="pb-2 font-medium w-40">采集时间</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(d, i) in results"
              :key="i"
              class="border-b border-gray-50 hover:bg-gray-50/50"
            >
              <td class="py-1.5 text-xs text-gray-400 font-mono">
                {{ d.ts_str || '—' }}
              </td>
              <td class="py-1.5 text-xs font-medium text-gray-700">
                {{ d.username || '—' }}
              </td>
              <td v-if="!compact" class="py-1.5 text-xs text-gray-500">
                {{ d.user_id || '—' }}
              </td>
              <td
                class="py-1.5 text-gray-800"
                :class="compact ? 'text-xs' : 'text-sm'"
                v-html="highlightKeyword(d.text)"
              />
              <td v-if="!compact" class="py-1.5 text-xs text-gray-400">
                {{ $formatTime(d.ts_abs_ms) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div v-if="total > limit" class="flex gap-2 mt-3">
        <button
          v-if="offset > 0"
          class="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
          @click="prevPage"
        >
          ← 上一页
        </button>
        <button
          v-if="offset + limit < total"
          class="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
          @click="nextPage"
        >
          下一页 →
        </button>
      </div>
    </template>
  </div>
</template>
