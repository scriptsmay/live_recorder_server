<script setup lang="ts">
/**
 * 录制会话 - 查看所有直播间的录制记录与弹幕处理
 *
 * 功能：
 * - 会话卡片列表（分页、状态过滤、直播间过滤）
 * - 文件列表展开（懒加载，由 SessionCard 管理）
 * - 投稿弹窗（由 UploadModal 管理）
 */
import { ref, computed, watch, onMounted } from 'vue'
import dayjs from 'dayjs'
import { useRoute, useRouter } from 'vue-router'
import { apiGet, apiDelete, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'
import Pagination from '@/components/Pagination.vue'
import SessionCard from './sessions/SessionCard.vue'
import UploadModal from './sessions/UploadModal.vue'
import type { RecordingSession, Room, UploadTemplate } from '@/types/api'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { confirm } = useConfirm()

// ---- Data ----
const sessions = ref<RecordingSession[]>([])
const rooms = ref<Room[]>([])
const templates = ref<UploadTemplate[]>([])
const total = ref(0)
const loading = ref(false)

// ---- Filters ----
const statusFilter = ref('all')
const currentPage = ref(1)
const dateFrom = ref('')
const dateTo = ref('')

const currentRoomId = computed(() => (route.query.room_id as string) || '')

const statusTabs = [
  { value: 'all', label: '全部' },
  { value: 'recording', label: '录制中' },
  { value: 'completed', label: '已完成' },
  { value: 'interrupted', label: '中断' },
]

// ---- Computed ----
const groupedSessions = computed(() => {
  const groups = new Map<string, RecordingSession[]>()

  for (const session of sessions.value) {
    const key = dayjs(session.started_at).isValid()
      ? dayjs(session.started_at).format('YYYY-MM-DD')
      : 'unknown'
    const list = groups.get(key) ?? []
    list.push(session)
    groups.set(key, list)
  }

  return Array.from(groups.entries()).map(([date, items]) => {
    let label = '未知日期'

    if (date !== 'unknown') {
      const current = dayjs(date)
      if (current.isSame(dayjs(), 'day')) {
        label = `今天 ${date}`
      } else if (current.isSame(dayjs().subtract(1, 'day'), 'day')) {
        label = `昨天 ${date}`
      } else {
        label = current.format('YYYY年MM月DD日')
      }
    }

    return { date, label, items }
  })
})

// ---- Upload Modal ----
const uploadModalOpen = ref(false)
const uploadSessionId = ref<number | null>(null)

// ---- Data Fetching ----
async function fetchRoomsAndTemplates() {
  try {
    const [roomsRes, templatesRes] = await Promise.all([
      apiGet<Room[]>('/api/rooms'),
      apiGet<UploadTemplate[]>('/api/upload_templates'),
    ])
    rooms.value = roomsRes.data || []
    templates.value = templatesRes.data || []
  } catch (err) {
    console.error('Failed to load rooms/templates:', err)
  }
}

async function fetchSessions() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    params.set('page', String(currentPage.value))
    params.set('limit', '10')

    // Room filter: convert room_id (from URL) to room_url (for API)
    const roomId = currentRoomId.value
    if (roomId) {
      const room = rooms.value.find((r) => String(r.id) === roomId)
      if (room) {
        params.set('room_url', room.room_url)
      }
    }

    if (dateFrom.value) params.set('date_from', dateFrom.value)
    if (dateTo.value) params.set('date_to', dateTo.value)
    if (statusFilter.value !== 'all') params.set('status', statusFilter.value)

    const res = await apiGet<{ rows: RecordingSession[]; total: number }>(
      '/api/sessions?' + params.toString(),
    )
    sessions.value = res.data.rows
    total.value = res.data.total
  } catch (err) {
    toast.error('加载会话失败: ' + (err instanceof ApiError ? err.message : String(err)))
    sessions.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

// Watch route query changes (room_id) and re-fetch
watch(
  () => route.query.room_id,
  () => {
    currentPage.value = 1
    fetchSessions()
  },
)

watch([dateFrom, dateTo], () => {
  currentPage.value = 1
  fetchSessions()
})

watch(statusFilter, () => {
  currentPage.value = 1
  fetchSessions()
})

// Initialize: load rooms/templates first, then sessions
onMounted(async () => {
  await fetchRoomsAndTemplates()
  fetchSessions()
})

// ---- Handlers ----
function selectRoom(roomId: string) {
  const query: Record<string, string> = {}
  if (roomId) query.room_id = roomId
  router.push({ path: '/sessions', query })
}

function handlePageChange(page: number) {
  currentPage.value = page
  fetchSessions()
}

function clearDateFilter() {
  dateFrom.value = ''
  dateTo.value = ''
}

async function handleDeleteSession(sessionId: number) {
  const ok = await confirm('确定删除此会话？此操作不会删除实际文件。')
  if (!ok) return
  try {
    await apiDelete(`/api/sessions/${sessionId}`)
    toast.success('会话已删除')
    fetchSessions()
  } catch (err) {
    toast.error('删除失败: ' + (err instanceof ApiError ? err.message : String(err)))
  }
}

function handleUpload(sessionId: number) {
  uploadSessionId.value = sessionId
  uploadModalOpen.value = true
}

function handleUploadSubmitted(message: string) {
  toast.success(message || '投稿任务已提交')
  uploadModalOpen.value = false
  setTimeout(() => fetchSessions(), 2000)
}

function handleUploadError(message: string) {
  toast.error('投稿失败: ' + message)
}
</script>

<template>
  <div>
    <!-- Page Title -->
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-gray-900">录制会话</h1>
      <p class="text-sm text-gray-500 mt-1">所有直播间的录制记录与弹幕处理</p>
    </div>

    <div class="bg-white rounded-xl border border-gray-200 p-4 mb-3 shadow-sm">
      <!-- Status Filter Bar -->
      <div class="mb-4">
        <div class="flex items-center flex-wrap gap-2">
          <span class="text-sm text-gray-500 shrink-0">状态：</span>
          <button
            v-for="tab in statusTabs"
            :key="tab.value"
            class="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full transition-colors"
            :class="
              statusFilter === tab.value
                ? 'bg-brand-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            "
            @click="statusFilter = tab.value"
          >
            <span
              v-if="tab.value !== 'all'"
              class="w-2 h-2 rounded-full shrink-0"
              :class="{
                'bg-green-400': tab.value === 'recording',
                'bg-blue-400': tab.value === 'completed',
                'bg-red-400': tab.value === 'interrupted',
              }"
            />
            {{ tab.label }}
          </button>
        </div>
      </div>

      <div class="mb-4">
        <div class="flex items-center flex-wrap gap-2">
          <span class="text-sm text-gray-500 shrink-0">日期：</span>
          <input
            v-model="dateFrom"
            type="date"
            class="h-8 rounded-lg border border-gray-300 px-2.5 text-xs text-gray-700"
          />
          <span class="text-xs text-gray-400">至</span>
          <input
            v-model="dateTo"
            type="date"
            class="h-8 rounded-lg border border-gray-300 px-2.5 text-xs text-gray-700"
          />
          <button
            v-if="dateFrom || dateTo"
            class="px-3 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
            @click="clearDateFilter"
          >
            清除
          </button>
        </div>
      </div>

      <!-- Room Filter Bar -->
      <div v-if="rooms.length > 0" class="">
        <div class="flex items-center flex-wrap gap-2">
          <span class="text-sm text-gray-500 shrink-0">主播：</span>
          <button
            class="px-3 py-1 text-xs font-medium rounded-full transition-colors"
            :class="
              !currentRoomId
                ? 'bg-brand-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            "
            @click="selectRoom('')"
          >
            全部
          </button>
          <button
            v-for="room in rooms"
            :key="room.id"
            class="px-3 py-1 text-xs font-medium rounded-full transition-colors"
            :class="
              currentRoomId === String(room.id)
                ? 'bg-brand-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            "
            @click="selectRoom(String(room.id))"
          >
            {{ room.room_name || '未命名' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Session List -->
    <div>
      <!-- Loading -->
      <div v-if="loading && sessions.length === 0" class="text-center py-12">
        <div
          class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"
        />
        <span class="text-sm text-gray-500">加载中...</span>
      </div>

      <!-- Empty -->
      <div
        v-else-if="sessions.length === 0"
        class="bg-white rounded-xl border border-gray-200 p-12 text-center shadow-sm"
      >
        <svg class="w-12 h-12 text-gray-300 mx-auto mb-3" fill="currentColor" viewBox="0 0 16 16">
          <path
            fill-rule="evenodd"
            d="M0 5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.983 1.738l3.11-1.382A1 1 0 0 1 16 4.269v7.462a1 1 0 0 1-1.406.913l-3.111-1.382A2 2 0 0 1 9.5 13H2a2 2 0 0 1-2-2zm11.5 5.175 3.5 1.556V4.269l-3.5 1.556zM2 4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z"
          />
        </svg>
        <p class="text-sm text-gray-400">
          {{ statusFilter !== 'all' ? '当前状态无匹配会话' : '暂无录制会话' }}
        </p>
      </div>

      <!-- Cards -->
      <template v-else>
        <section v-for="group in groupedSessions" :key="group.date" class="mb-5 last:mb-0">
          <div class="flex items-center gap-3 mb-3 px-1">
            <h2 class="text-sm font-semibold text-gray-900">{{ group.label }}</h2>
            <span class="text-xs text-gray-400">{{ group.items.length }} 条会话</span>
            <div class="h-px bg-gray-200 flex-1" />
          </div>

          <SessionCard
            v-for="session in group.items"
            :key="session.id"
            :session="session"
            :templates="templates"
            @delete-session="handleDeleteSession"
            @upload="handleUpload"
          />
        </section>
      </template>
    </div>

    <!-- Pagination -->
    <Pagination v-if="total > 0" :current="currentPage" :total="total" :page-size="10" @change="handlePageChange" />

    <!-- Upload Modal -->
    <UploadModal
      :open="uploadModalOpen"
      :session-id="uploadSessionId"
      :templates="templates"
      @close="uploadModalOpen = false"
      @submitted="handleUploadSubmitted"
      @error="handleUploadError"
    />
  </div>
</template>
