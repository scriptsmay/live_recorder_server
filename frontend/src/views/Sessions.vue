<script setup lang="ts">
/**
 * 录制会话 - 查看所有直播间的录制记录与弹幕处理
 *
 * 功能：
 * - 统计卡片（当前页会话分布）
 * - 服务端筛选（状态 / 直播间 / 日期区间）+ 分页
 * - 会话卡片列表（按日期分组，文件列表懒加载由 SessionCard 管理）
 * - 投稿弹窗（由 UploadModal 管理）
 *
 * 设计：Linear Aesthetic —— 吸顶操作栏 + StatCard 统计卡 + 分段筛选工具条 +
 * 超细描边会话卡；全部使用语义色类（gray-* / brand-* / hairline-card），
 * 自动适配亮/深双主题。
 */
import { ref, computed, watch, onMounted } from 'vue'
import dayjs from 'dayjs'
import { useRoute, useRouter } from 'vue-router'
import { apiGet, apiDelete, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'
import Pagination from '@/components/Pagination.vue'
import StatCard from '@/components/ui/StatCard.vue'
import SessionCard from './sessions/SessionCard.vue'
import UploadModal from './sessions/UploadModal.vue'
import type { RecordingSession, Room, UploadTemplate } from '@/types/api'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { confirm } = useConfirm()

const fieldClass =
  'h-8 rounded-lg border border-gray-300 bg-white px-2.5 text-xs text-gray-700 outline-none transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-500/50'

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

const hasDateFilter = computed(() => Boolean(dateFrom.value || dateTo.value))
const hasAnyFilter = computed(
  () => statusFilter.value !== 'all' || hasDateFilter.value || Boolean(currentRoomId.value),
)

// ---- Computed ----
function pageCount(status: string) {
  return sessions.value.filter((s) => s.status === status).length
}

const statCards = computed(() => [
  {
    label: '本页会话',
    value: String(sessions.value.length),
    sublines: [`共 ${total.value} 条记录`],
    tone: 'indigo',
    iconPath:
      'M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Zm0 5.25h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Zm0 5.25h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z',
  },
  {
    label: '录制中',
    value: String(pageCount('recording')),
    sublines: ['正在写入磁盘'],
    tone: 'emerald',
    iconPath:
      'm15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z',
  },
  {
    label: '已完成',
    value: String(pageCount('completed')),
    sublines: ['已正常结束'],
    tone: 'blue',
    iconPath: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  },
  {
    label: '中断',
    value: String(pageCount('interrupted')),
    sublines: ['异常结束'],
    tone: 'rose',
    iconPath:
      'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
  },
])

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
        label = `今天 · ${date}`
      } else if (current.isSame(dayjs().subtract(1, 'day'), 'day')) {
        label = `昨天 · ${date}`
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

async function refresh() {
  await fetchRoomsAndTemplates()
  await fetchSessions()
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

function clearFilters() {
  statusFilter.value = 'all'
  dateFrom.value = ''
  dateTo.value = ''
  selectRoom('')
  currentPage.value = 1
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
  <div class="pb-16">
    <!-- 吸顶操作栏 -->
    <header
      class="sticky top-14 z-30 -mx-4 mb-6 border-b border-gray-200/70 bg-surface/80 px-4 py-4 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold tracking-tight text-gray-900">录制会话</h1>
          <p class="mt-0.5 text-xs text-gray-500">所有直播间的录制记录与弹幕处理</p>
        </div>

        <div class="flex items-center gap-2.5">
          <span
            class="hidden items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 sm:inline-flex"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-brand-500" />
            {{ total }} 条会话
          </span>
          <button
            class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="loading"
            @click="refresh"
          >
            <svg
              class="h-4 w-4"
              :class="loading ? 'animate-spin' : ''"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
              />
            </svg>
            刷新
          </button>
        </div>
      </div>
    </header>

    <!-- 统计卡片 -->
    <div class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        v-for="card in statCards"
        :key="card.label"
        :label="card.label"
        :value="card.value"
        :sublines="card.sublines"
        :tone="card.tone"
        :icon-path="card.iconPath"
        :loading="loading && sessions.length === 0"
      />
    </div>

    <!-- 筛选工具条 -->
    <div class="hairline-card mb-5 rounded-xl p-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <!-- 状态分段筛选 -->
        <div
          class="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50/60 p-0.5"
        >
          <button
            v-for="tab in statusTabs"
            :key="tab.value"
            class="inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium transition-all"
            :class="
              statusFilter === tab.value
                ? 'bg-brand-600 text-white shadow-sm'
                : 'text-gray-500 hover:bg-white hover:text-gray-800'
            "
            @click="statusFilter = tab.value"
          >
            {{ tab.label }}
          </button>
        </div>

        <div class="hidden h-5 w-px bg-gray-200 sm:block" />

        <!-- 主播筛选 -->
        <label class="flex items-center gap-1.5 text-xs text-gray-400">
          主播
          <select
            :class="fieldClass"
            :value="currentRoomId"
            @change="selectRoom(($event.target as HTMLSelectElement).value)"
          >
            <option value="">全部主播</option>
            <option v-for="room in rooms" :key="room.id" :value="String(room.id)">
              {{ room.room_name || '未命名' }}
            </option>
          </select>
        </label>

        <!-- 日期区间 -->
        <div class="flex items-center gap-1.5 text-xs text-gray-400">
          日期
          <input v-model="dateFrom" type="date" :class="fieldClass" />
          <span class="text-gray-300">至</span>
          <input v-model="dateTo" type="date" :class="fieldClass" />
        </div>

        <button
          v-if="hasAnyFilter"
          class="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-800"
          @click="clearFilters"
        >
          <svg
            class="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
          清除筛选
        </button>
      </div>
    </div>

    <!-- 会话列表 -->
    <div>
      <!-- 加载骨架 -->
      <div v-if="loading && sessions.length === 0" class="space-y-3">
        <div v-for="n in 3" :key="n" class="hairline-card rounded-xl p-4">
          <div class="mb-4 flex items-center gap-3">
            <div class="h-4 w-12 animate-pulse rounded bg-gray-200" />
            <div class="h-4 w-40 animate-pulse rounded bg-gray-200" />
            <div class="ml-auto h-6 w-20 animate-pulse rounded-full bg-gray-100" />
          </div>
          <div class="grid gap-4 lg:grid-cols-[minmax(0,1.75fr)_minmax(264px,1fr)]">
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-[132px_minmax(0,1fr)]">
              <div class="aspect-video animate-pulse rounded-lg bg-gray-100" />
              <div class="space-y-3">
                <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div v-for="i in 4" :key="i" class="h-14 animate-pulse rounded-lg bg-gray-100" />
                </div>
                <div class="h-3 w-2/3 animate-pulse rounded bg-gray-100" />
                <div class="h-3 w-1/2 animate-pulse rounded bg-gray-100" />
              </div>
            </div>
            <div class="h-full min-h-[120px] animate-pulse rounded-xl bg-gray-100" />
          </div>
        </div>
      </div>

      <!-- 空态 -->
      <div
        v-else-if="sessions.length === 0"
        class="hairline-card rounded-xl px-6 py-16 text-center"
      >
        <div
          class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-gray-200 bg-gray-50 text-gray-400"
        >
          <svg
            class="h-6 w-6"
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
        </div>
        <p class="text-sm font-medium text-gray-500">
          {{ hasAnyFilter ? '当前筛选条件下没有会话' : '暂无录制会话' }}
        </p>
        <p class="mt-1 text-xs text-gray-400">
          {{
            hasAnyFilter
              ? '试试调整状态、主播或日期筛选'
              : '当直播间开始录制后，会话会自动出现在这里'
          }}
        </p>
        <button
          v-if="hasAnyFilter"
          class="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
          @click="clearFilters"
        >
          清除筛选
        </button>
      </div>

      <!-- 会话卡片 -->
      <template v-else>
        <section v-for="group in groupedSessions" :key="group.date" class="mb-5 last:mb-0">
          <div class="mb-3 flex items-center gap-3 px-1">
            <h2 class="text-sm font-semibold tracking-tight text-gray-900">{{ group.label }}</h2>
            <span class="text-xs tabular-nums text-gray-400">{{ group.items.length }} 条</span>
            <div class="h-px flex-1 bg-gray-200" />
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

    <!-- 分页 -->
    <Pagination
      v-if="total > 0"
      :current="currentPage"
      :total="total"
      :page-size="10"
      @change="handlePageChange"
    />

    <!-- 投稿弹窗 -->
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
