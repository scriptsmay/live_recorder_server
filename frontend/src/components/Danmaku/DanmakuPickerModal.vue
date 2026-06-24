<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { apiGet } from '@/utils/api'
import Modal from '@/components/Modal.vue'
import Pagination from '@/components/Pagination.vue'

// ---- 类型 ----
interface Session {
  id: number
  room_name: string | null
  danmaku_event_count: number
  started_at: string | null
  status: string
}

interface PreviewEvent {
  ts_ms: number | null
  ts_str: string
  text: string
  username: string
}

// ---- Props & Emits ----
const props = withDefaults(
  defineProps<{
    visible: boolean
    modelValue?: number | null
  }>(),
  { modelValue: null },
)

const emit = defineEmits<{
  'update:visible': [value: boolean]
  select: [session: Session]
}>()

// ---- 状态 ----
const SESSIONS_PER_PAGE = 20

const sessionSearch = ref('')
const sessions = ref<Session[]>([])
const sessionsPage = ref(1)
const sessionsLoading = ref(false)

// 客户端分页：后端返回全部数据（最多 500 条），前端切片
const sessionsTotal = computed(() => sessions.value.length)
const sessionsTotalPages = computed(() => Math.ceil(sessions.value.length / SESSIONS_PER_PAGE) || 1)
const pagedSessions = computed(() => {
  const start = (sessionsPage.value - 1) * SESSIONS_PER_PAGE
  return sessions.value.slice(start, start + SESSIONS_PER_PAGE)
})

const selectedSession = ref<Session | null>(null)
const previewEvents = ref<PreviewEvent[]>([])
const previewTotal = ref(0)
const previewOffset = ref(0)
const previewLimit = ref(100)
const previewSearch = ref('')
const previewLoading = ref(false)

let sessionSearchTimer: ReturnType<typeof setTimeout> | null = null

// ---- 工具函数 ----
function formatTime(ts: string | null): string {
  if (!ts) return '-'
  return ts.replace('T', ' ').replace(/\.\d+Z?$/, '')
}

// ---- 数据加载 ----
async function loadSessions() {
  sessionsLoading.value = true
  try {
    const params = new URLSearchParams()
    if (sessionSearch.value.trim()) {
      params.set('search', sessionSearch.value.trim())
    }
    const res = await apiGet<Session[]>(`/api/danmaku-toolbox/sessions?${params}`)
    const body = res as unknown as { data: Session[] }
    sessions.value = body.data ?? []
  } catch {
    sessions.value = []
  } finally {
    sessionsLoading.value = false
  }
}

async function loadPreview() {
  if (!selectedSession.value) return
  previewLoading.value = true
  try {
    const params = new URLSearchParams({
      limit: String(previewLimit.value),
      offset: String(previewOffset.value),
    })
    if (previewSearch.value.trim()) {
      params.set('search', previewSearch.value.trim())
    }
    const res = await apiGet<PreviewEvent[]>(
      `/api/danmaku-toolbox/sessions/${selectedSession.value.id}/events?${params}`,
    )
    const body = res as unknown as { data: PreviewEvent[]; total: number }
    previewEvents.value = body.data ?? []
    previewTotal.value = body.total ?? 0
  } catch {
    previewEvents.value = []
    previewTotal.value = 0
  } finally {
    previewLoading.value = false
  }
}

// ---- 交互 ----
function selectSession(session: Session) {
  if (selectedSession.value?.id === session.id) {
    selectedSession.value = null
    previewEvents.value = []
    previewTotal.value = 0
    return
  }
  selectedSession.value = session
  previewSearch.value = ''
  previewOffset.value = 0
  loadPreview()
}

function onSessionSearchInput() {
  if (sessionSearchTimer) clearTimeout(sessionSearchTimer)
  sessionSearchTimer = setTimeout(() => {
    sessionsPage.value = 1
    selectedSession.value = null
    previewEvents.value = []
    previewTotal.value = 0
    loadSessions()
  }, 300)
}

function onPreviewSearchInput() {
  previewOffset.value = 0
  loadPreview()
}

function previewNextPage() {
  previewOffset.value += previewLimit.value
  loadPreview()
}

function previewPrevPage() {
  previewOffset.value = Math.max(0, previewOffset.value - previewLimit.value)
  loadPreview()
}

function confirmSelect() {
  if (selectedSession.value) {
    emit('select', selectedSession.value)
    close()
  }
}

function close() {
  emit('update:visible', false)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

// ---- 生命周期 ----
watch(
  () => props.visible,
  (v) => {
    if (v) {
      sessionSearch.value = ''
      sessionsPage.value = 1
      selectedSession.value = null
      previewEvents.value = []
      previewTotal.value = 0
      previewSearch.value = ''
      previewOffset.value = 0
      loadSessions()
      window.addEventListener('keydown', onKeydown)
    } else {
      window.removeEventListener('keydown', onKeydown)
    }
  },
)
</script>

<template>
  <Modal :visible="visible" title="选择弹幕会话" max-width="max-w-5xl" @update:visible="close">
    <!-- 搜索栏 -->
    <div class="px-6 pt-4 pb-3 border-b border-gray-100">
      <input
        v-model="sessionSearch"
        type="text"
        placeholder="搜索主播名..."
        class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
        @input="onSessionSearchInput"
      />
    </div>

    <!-- 主内容区：左侧会话列表 + 右侧弹幕预览 -->
    <div class="flex min-h-[400px] max-h-[60vh]">
      <!-- 左侧：会话列表 -->
      <div class="w-full lg:w-1/2 border-r border-gray-100 flex flex-col">
        <div class="flex-1 overflow-y-auto">
          <div v-if="sessionsLoading" class="py-12 text-center text-sm text-gray-400">
            加载中...
          </div>
          <div v-else-if="sessions.length === 0" class="py-12 text-center text-sm text-gray-400">
            暂无弹幕会话
          </div>
          <table v-else class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-gray-500 border-b border-gray-100">
                <th class="p-2 font-medium w-16">ID</th>
                <th class="p-2 font-medium">主播</th>
                <th class="p-2 font-medium w-20 text-right">弹幕</th>
                <th class="p-2 font-medium w-36">时间</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="session in pagedSessions"
                :key="session.id"
                class="cursor-pointer transition-colors border-b border-gray-50"
                :class="
                  selectedSession?.id === session.id
                    ? 'bg-brand-50 ring-1 ring-brand-300'
                    : 'hover:bg-gray-50'
                "
                @click="selectSession(session)"
              >
                <td class="px-2 py-2 font-mono text-xs text-gray-500">#{{ session.id }}</td>
                <td class="px-2 py-2 font-medium">{{ session.room_name || '未知' }}</td>
                <td class="px-2 py-2 text-right text-xs text-gray-600">
                  {{ session.danmaku_event_count }}
                </td>
                <td class="px-2 py-2 text-xs text-gray-400">
                  {{ formatTime(session.started_at) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 左侧分页 -->
        <div v-if="sessionsTotalPages > 1" class="px-4 py-2 border-t border-gray-100 shrink-0">
          <Pagination
            :current="sessionsPage"
            :total="sessionsTotal"
            :page-size="SESSIONS_PER_PAGE"
            @change="
              (p: number) => {
                sessionsPage = p
              }
            "
          />
        </div>
      </div>

      <!-- 右侧：弹幕预览 -->
      <div class="hidden lg:flex lg:w-1/2 flex-col">
        <!-- 预览搜索 -->
        <div class="px-4 py-3 border-b border-gray-100">
          <input
            v-model="previewSearch"
            type="text"
            placeholder="搜索弹幕内容..."
            class="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
            @input="onPreviewSearchInput"
          />
        </div>

        <!-- 预览内容 -->
        <div class="flex-1 overflow-y-auto px-4 py-3">
          <div
            v-if="!selectedSession"
            class="flex items-center justify-center h-full text-sm text-gray-400"
          >
            ← 点击左侧会话预览弹幕
          </div>
          <div v-else-if="previewLoading" class="flex items-center justify-center h-full">
            <div
              class="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"
            />
          </div>
          <div
            v-else-if="previewEvents.length === 0"
            class="flex items-center justify-center h-full text-sm text-gray-400"
          >
            无弹幕数据
          </div>
          <div v-else class="space-y-1">
            <div
              v-for="(evt, i) in previewEvents"
              :key="i"
              class="text-sm leading-relaxed flex gap-2"
            >
              <span class="text-xs text-gray-400 font-mono shrink-0 w-14">{{
                evt.ts_str || '--:--:--'
              }}</span>
              <span class="shrink-0 text-xs font-medium text-gray-500">{{
                evt.username || '匿名'
              }}</span>
              <span class="text-gray-800 break-all">{{ evt.text }}</span>
            </div>
          </div>
        </div>

        <!-- 预览分页 -->
        <div
          v-if="previewTotal > previewLimit"
          class="px-4 py-2 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500 shrink-0"
        >
          <span>
            {{ previewOffset + 1 }}-{{
              Math.min(previewOffset + previewEvents.length, previewTotal)
            }}
            / {{ previewTotal }}
          </span>
          <div class="flex gap-1">
            <button
              :disabled="previewOffset === 0"
              class="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
              @click="previewPrevPage"
            >
              上一页
            </button>
            <button
              :disabled="previewOffset + previewLimit >= previewTotal"
              class="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
              @click="previewNextPage"
            >
              下一页
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部操作栏 -->
    <div
      class="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl"
    >
      <div class="text-sm text-gray-500">
        <template v-if="selectedSession">
          已选：<span class="font-medium text-gray-900">{{
            selectedSession.room_name || '未知主播'
          }}</span>
          <span class="text-gray-400 ml-1">({{ selectedSession.danmaku_event_count }} 条弹幕)</span>
        </template>
        <template v-else> 请选择一个弹幕会话 </template>
      </div>
      <div class="flex gap-2">
        <button
          class="px-4 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors"
          @click="close"
        >
          取消
        </button>
        <button
          class="px-4 py-1.5 text-sm rounded-lg text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :class="selectedSession ? 'bg-brand-600 hover:bg-brand-700' : 'bg-gray-300'"
          :disabled="!selectedSession"
          @click="confirmSelect"
        >
          确认选择
        </button>
      </div>
    </div>
  </Modal>
</template>
