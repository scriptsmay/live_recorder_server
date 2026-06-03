<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { useDanmakuToolboxStore, type DanmakuSearchResult } from '@/stores/danmaku-toolbox'
import { useToast } from '@/utils/toast'

const props = defineProps<{
  visible: boolean
  sessionId: number | null
  roomName: string
}>()

const emit = defineEmits<{
  close: []
}>()

const store = useDanmakuToolboxStore()
const toast = useToast()

const keyword = ref('')
const results = ref<DanmakuSearchResult[]>([])
const total = ref(0)
const offset = ref(0)
const limit = ref(50)
const searching = ref(false)
const searched = ref(false)
const searchInputRef = ref<HTMLInputElement | null>(null)

async function doSearch(newOffset = 0) {
  if (!props.sessionId || !keyword.value.trim()) return
  offset.value = newOffset
  searching.value = true
  searched.value = true
  try {
    const res = await store.searchDanmaku(
      props.sessionId,
      keyword.value.trim(),
      offset.value,
      limit.value,
    )
    results.value = res.results
    total.value = res.total
  } catch (err) {
    toast.error('搜索失败: ' + (err instanceof Error ? err.message : '未知错误'))
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
  doSearch(Math.max(0, offset.value - limit.value))
}

function nextPage() {
  doSearch(offset.value + limit.value)
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

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function reset() {
  keyword.value = ''
  results.value = []
  total.value = 0
  offset.value = 0
  searched.value = false
  nextTick(() => {
    searchInputRef.value?.focus()
  })
}

defineExpose({ reset })
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" class="fixed inset-0 z-[9998] flex items-center justify-center">
        <!-- 遮罩 -->
        <div class="absolute inset-0 bg-black/40" />

        <!-- 弹窗 -->
        <div
          class="relative bg-white rounded-xl shadow-2xl max-w-3xl w-full mx-4 max-h-[85vh] flex flex-col overflow-hidden"
        >
          <!-- 头部 -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <h3 class="text-base font-semibold text-gray-900">
              弹幕搜索
              <span class="text-sm font-normal text-gray-500 ml-2">
                #{{ sessionId }} {{ roomName }}
              </span>
            </h3>
            <button
              class="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              @click="emit('close')"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          <!-- 搜索栏 -->
          <div class="px-6 py-3 border-b border-gray-100">
            <div class="flex gap-2">
              <input
                ref="searchInputRef"
                v-model="keyword"
                type="text"
                class="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all"
                placeholder="搜索弹幕内容或用户名..."
                @keydown="handleKeydown"
              />
              <button
                class="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
                :disabled="searching || !keyword.trim()"
                @click="handleSearch"
              >
                {{ searching ? '搜索中...' : '搜索' }}
              </button>
            </div>
          </div>

          <!-- 结果区域 -->
          <div class="flex-1 overflow-y-auto px-6 py-4">
            <!-- 初始状态 -->
            <div v-if="!searched && !searching" class="text-center py-8 text-sm text-gray-400">
              输入关键词搜索弹幕
            </div>

            <!-- 加载中 -->
            <div v-else-if="searching" class="flex items-center justify-center gap-2 py-8">
              <div
                class="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"
              />
              <span class="text-sm text-gray-500">搜索中...</span>
            </div>

            <!-- 无结果 -->
            <div v-else-if="results.length === 0" class="text-center py-8 text-sm text-gray-400">
              无匹配弹幕
            </div>

            <!-- 结果列表 -->
            <div v-else>
              <div class="text-xs text-gray-500 mb-2">
                共 {{ total }} 条匹配 (显示 {{ offset + 1 }}-{{
                  Math.min(offset + results.length, total)
                }})
              </div>
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-500 border-b border-gray-200">
                    <th class="pb-2 font-medium w-24">时间</th>
                    <th class="pb-2 font-medium w-32">用户</th>
                    <th class="pb-2 font-medium">内容</th>
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
                    <td class="py-1.5 text-sm text-gray-800" v-html="highlightKeyword(d.text)" />
                  </tr>
                </tbody>
              </table>

              <!-- 分页 -->
              <div v-if="total > limit" class="flex gap-2 mt-4">
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
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active {
  transition: all 0.2s ease-out;
}
.modal-leave-active {
  transition: all 0.15s ease-in;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
