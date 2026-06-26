<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useDanmakuToolboxStore, type ToolboxSession } from '@/stores/danmaku-toolbox'
import { useToast } from '@/utils/toast'
import DanmakuSearchPanel from '@/components/Danmaku/DanmakuSearchPanel.vue'
import Modal from '@/components/Modal.vue'

const store = useDanmakuToolboxStore()
const toast = useToast()

// ---- 本地状态 ----
const currentFilter = ref('all')
const searchKeyword = ref('')

// 搜索弹窗
const searchModalVisible = ref(false)
const searchModalSessionId = ref<number | null>(null)
const searchModalRoomName = ref('')
const searchPanelRef = ref<InstanceType<typeof DanmakuSearchPanel> | null>(null)

// ---- 筛选逻辑 ----
const filterOptions = [
  { value: 'all', label: '全部' },
  { value: 'has_data', label: '有数据' },
]

const filteredSessions = computed<ToolboxSession[]>(() => {
  let list = store.sessions

  if (currentFilter.value === 'has_data') {
    list = list.filter((s) => s.danmaku_event_count > 0)
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

// ---- 生命周期 ----
onMounted(async () => {
  await store.fetchSessions()
})

// ---- 操作 ----
function handleSearchDanmaku(sessionId: number, roomName: string) {
  searchModalSessionId.value = sessionId
  searchModalRoomName.value = roomName
  searchModalVisible.value = true
  searchPanelRef.value?.reset()
}

function handleRefreshAll() {
  store.fetchSessions()
  toast.info('已刷新')
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
</script>

<template>
  <div>
    <!-- 页面标题 -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">弹幕工具箱</h1>
        <p class="text-sm text-gray-500 mt-1">弹幕数据管理：会话筛选、弹幕搜索</p>
      </div>
      <button
        class="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
        @click="handleRefreshAll"
      >
        刷新
      </button>
    </div>

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

      <div v-else class="space-y-3">
        <div
          v-for="session in filteredSessions"
          :key="session.id"
          class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm hover:shadow-md transition-shadow"
        >
          <div class="flex items-start gap-3">
            <!-- 会话信息 -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-sm font-semibold text-gray-900 truncate">
                  {{ session.room_name || session.room_url }}
                </span>
                <span class="text-xs text-gray-400">#{{ session.id }}</span>
              </div>

              <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                <span>弹幕: {{ session.danmaku_event_count }} 条</span>
                <span>{{ formatDate(session.started_at) }}</span>
              </div>
            </div>

            <!-- 操作按钮 -->
            <div class="flex items-center gap-2 shrink-0">
              <button
                class="px-2.5 py-1 text-xs font-medium rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50 transition-colors"
                :disabled="session.danmaku_event_count === 0"
                @click="handleSearchDanmaku(session.id, session.room_name || '')"
              >
                搜索弹幕
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 弹幕搜索弹窗 -->
    <Modal
      :visible="searchModalVisible"
      max-width="max-w-3xl"
      @update:visible="searchModalVisible = $event"
    >
      <template #header>
        <h3 class="text-lg font-semibold text-gray-900">
          弹幕搜索
          <span class="text-sm font-normal text-gray-500 ml-2">
            #{{ searchModalSessionId }} {{ searchModalRoomName }}
          </span>
        </h3>
      </template>
      <div class="px-6 py-4">
        <DanmakuSearchPanel
          v-if="searchModalSessionId"
          ref="searchPanelRef"
          :session-id="searchModalSessionId"
        />
      </div>
    </Modal>
  </div>
</template>
