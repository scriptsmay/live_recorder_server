<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDanmakuToolboxStore, type ToolboxSession } from '@/stores/danmaku-toolbox'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'
import StatusCards from './danmaku-toolbox/StatusCards.vue'
import SessionCard from './danmaku-toolbox/SessionCard.vue'
import DanmakuSearchModal from './danmaku-toolbox/DanmakuSearchModal.vue'

const store = useDanmakuToolboxStore()
const toast = useToast()
const { confirm } = useConfirm()

// ---- 本地状态 ----
const currentFilter = ref('all')
const searchKeyword = ref('')
const selectedSessions = ref<Set<number>>(new Set())
let pollTimer: ReturnType<typeof setInterval> | null = null

// 搜索弹窗
const searchModalVisible = ref(false)
const searchModalSessionId = ref<number | null>(null)
const searchModalRoomName = ref('')
const searchModalRef = ref<InstanceType<typeof DanmakuSearchModal> | null>(null)

// ---- 筛选逻辑 ----
const filterOptions = [
  { value: 'all', label: '全部' },
  { value: 'has_data', label: '有数据' },
  { value: 'ass_ready', label: 'ASS 就绪' },
  { value: 'burned', label: '已压制' },
  { value: 'unburned', label: '未压制' },
]

const filteredSessions = computed<ToolboxSession[]>(() => {
  let list = store.sessions

  if (currentFilter.value === 'has_data') {
    list = list.filter((s) => s.danmaku_event_count > 0)
  } else if (currentFilter.value === 'ass_ready') {
    list = list.filter((s) => s.has_ass_ready)
  } else if (currentFilter.value === 'burned') {
    list = list.filter((s) => s.danmaku_burn_completed > 0)
  } else if (currentFilter.value === 'unburned') {
    list = list.filter(
      (s) => s.has_ass_ready && (s.danmaku_burn_completed || 0) < (s.ass_segment_count || 0),
    )
  }

  const kw = searchKeyword.value.trim().toLowerCase()
  if (kw) {
    list = list.filter(
      (s) =>
        String(s.id).includes(kw) ||
        (s.room_name || '').toLowerCase().includes(kw) ||
        (s.room_url || '').toLowerCase().includes(kw),
    )
  }

  return list
})

const selectedCount = computed(() => selectedSessions.value.size)

// ---- 生命周期 ----
onMounted(async () => {
  await Promise.all([store.fetchSessions(), store.fetchQueueStatus()])
  pollTimer = setInterval(() => {
    store.fetchQueueStatus()
  }, 15000)
})

onUnmounted(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})

// ---- 选择管理 ----
function toggleSelect(sessionId: number) {
  const next = new Set(selectedSessions.value)
  if (next.has(sessionId)) {
    next.delete(sessionId)
  } else {
    next.add(sessionId)
  }
  selectedSessions.value = next
}

// ---- 操作 ----
async function handleGenerateAss(sessionId: number) {
  const success = await store.generateAss(sessionId)
  if (success) {
    setTimeout(() => store.fetchSessions(), 1000)
  }
}

async function handleBurnSession(sessionId: number, force: boolean) {
  const msg = force
    ? '确认强制重新压制此会话？（将覆盖已有产物）'
    : '确认将此会话全部可压制分段加入弹幕压制队列？'
  const ok = await confirm(msg)
  if (!ok) return
  const success = await store.burnSession(sessionId, force)
  if (success) {
    setTimeout(() => {
      store.fetchSessions()
      store.fetchQueueStatus()
    }, 1000)
  }
}

function handleSearchDanmaku(sessionId: number, roomName: string) {
  searchModalSessionId.value = sessionId
  searchModalRoomName.value = roomName
  searchModalVisible.value = true
  searchModalRef.value?.reset()
}

async function handleBatchBurn() {
  if (selectedSessions.value.size === 0) return
  const ok = await confirm(`确认将 ${selectedSessions.value.size} 个会话加入弹幕压制队列？`)
  if (!ok) return

  let totalEnqueued = 0
  for (const sid of selectedSessions.value) {
    const result = await store.burnSession(sid)
    if (result) totalEnqueued++
  }
  toast.success(`批量入队完成: ${totalEnqueued} 个会话`)
  selectedSessions.value = new Set()
  setTimeout(() => {
    store.fetchSessions()
    store.fetchQueueStatus()
  }, 1000)
}

async function handleBatchAss() {
  if (selectedSessions.value.size === 0) return
  const ok = await confirm(`确认为 ${selectedSessions.value.size} 个会话重新生成 ASS？`)
  if (!ok) return

  let success = 0
  for (const sid of selectedSessions.value) {
    const result = await store.generateAss(sid)
    if (result) success++
  }
  toast.success(`批量 ASS 生成完成: ${success}/${selectedSessions.value.size}`)
  setTimeout(() => store.fetchSessions(), 1000)
}

function handleRefreshAll() {
  store.fetchSessions()
  store.fetchQueueStatus()
  toast.info('已刷新')
}
</script>

<template>
  <div>
    <!-- 页面标题 -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">弹幕工具箱</h1>
        <p class="text-sm text-gray-500 mt-1">
          弹幕压制管理：会话筛选、批量压制、状态监控、产物管理
        </p>
      </div>
      <button
        class="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
        @click="handleRefreshAll"
      >
        刷新
      </button>
    </div>

    <!-- 状态卡片 -->
    <StatusCards
      :active-captures="store.queueStatus?.active_captures?.count ?? 0"
      :queue-length="store.queueStatus?.burn_queue?.queue_length ?? 0"
      :processing="store.queueStatus?.burn_queue?.processing ?? 0"
      :session-count="store.sessions.length"
    />

    <!-- 筛选条 -->
    <div class="bg-white rounded-xl border border-gray-200 p-4 mb-4 shadow-sm">
      <div class="flex items-center flex-wrap gap-3">
        <div class="flex items-center gap-2">
          <span class="text-sm text-gray-500 shrink-0">弹幕状态：</span>
          <button
            v-for="opt in filterOptions"
            :key="opt.value"
            class="px-3 py-1 text-xs font-medium rounded-full transition-colors"
            :class="
              currentFilter === opt.value
                ? 'bg-brand-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            "
            @click="currentFilter = opt.value"
          >
            {{ opt.label }}
          </button>
        </div>

        <div class="flex items-center ml-auto shrink-0">
          <input
            v-model="searchKeyword"
            type="text"
            class="w-60 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all"
            placeholder="搜索房间名或 Session ID..."
          />
        </div>
      </div>
    </div>

    <!-- 批量操作栏 -->
    <div class="flex items-center gap-2 mb-4 flex-wrap">
      <button
        class="px-3 py-1.5 text-sm font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="selectedCount === 0"
        @click="handleBatchBurn"
      >
        批量压制
      </button>
      <button
        class="px-3 py-1.5 text-sm font-medium rounded-lg border border-sky-300 text-sky-700 hover:bg-sky-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="selectedCount === 0"
        @click="handleBatchAss"
      >
        批量生成 ASS
      </button>
      <span class="text-sm text-gray-500">已选 {{ selectedCount }} 个会话</span>
    </div>

    <!-- 会话列表 -->
    <div>
      <div v-if="store.loading && store.sessions.length === 0" class="text-center py-12">
        <div
          class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"
        />
        <span class="text-sm text-gray-500">加载中...</span>
      </div>

      <div
        v-else-if="filteredSessions.length === 0"
        class="bg-white rounded-xl border border-gray-200 p-12 text-center shadow-sm"
      >
        <p class="text-sm text-gray-400">无匹配的弹幕会话</p>
      </div>

      <template v-else>
        <SessionCard
          v-for="session in filteredSessions"
          :key="session.id"
          :session="session"
          :selected="selectedSessions.has(session.id)"
          @toggle-select="toggleSelect"
          @generate-ass="handleGenerateAss"
          @burn-session="handleBurnSession"
          @search-danmaku="handleSearchDanmaku"
        />
      </template>
    </div>

    <!-- 弹幕搜索弹窗 -->
    <DanmakuSearchModal
      ref="searchModalRef"
      :visible="searchModalVisible"
      :session-id="searchModalSessionId"
      :room-name="searchModalRoomName"
      @close="searchModalVisible = false"
    />
  </div>
</template>
