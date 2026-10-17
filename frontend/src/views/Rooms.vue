<script setup lang="ts">
/**
 * 直播间管理 - CRUD 操作
 *
 * - 直播间列表（分页、状态过滤）
 * - 新增/编辑弹窗
 * - 暂停/恢复/停止/删除操作
 * - 统计卡片
 *
 * 设计：Linear Aesthetic —— 吸顶操作栏 + 统计卡片 + 分段筛选 + 超细描边表格。
 * 全部使用语义色类（gray-* / brand-* / hairline-card），自动适配亮/深双主题。
 */
import { ref, computed, onMounted } from 'vue'
import { apiGet, apiPost, apiDelete, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'
import Pagination from '@/components/Pagination.vue'
import StatCard from '@/components/ui/StatCard.vue'
import RoomFormModal from './rooms/RoomFormModal.vue'
import type { Room, UploadTemplate } from '@/types/api'
import { formatTime } from '@/utils/lib'

interface SettingsMap {
  downloader?: string
  [key: string]: unknown
}

type StatusKey = 'all' | 'recording' | 'idle' | 'paused'

const toast = useToast()
const { confirm } = useConfirm()

// --- 状态 ---
const loading = ref(true)
const rooms = ref<Room[]>([])
const total = ref(0)
const page = ref(1)
const templates = ref<UploadTemplate[]>([])
const downloaderName = ref<string>('')

// 筛选
const statusFilter = ref<StatusKey>('all')

// 弹窗
const modalVisible = ref(false)
const editId = ref<number | null>(null)
const editLimited = ref(false)

// 操作按钮基础样式
const btnBase =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1.5 text-xs font-medium transition-colors'

// --- 计算属性 ---
const filteredRooms = computed(() => {
  if (statusFilter.value === 'all') return rooms.value
  return rooms.value.filter((r) => r.status === statusFilter.value)
})

const countTotal = computed(() => rooms.value.length)
const countRecording = computed(() => rooms.value.filter((r) => r.status === 'recording').length)
const countLive = computed(
  () => rooms.value.filter((r) => r.polling_enabled && r.last_live_status).length,
)
const countIdle = computed(() => rooms.value.filter((r) => r.status === 'idle').length)
const countPaused = computed(() => rooms.value.filter((r) => r.status === 'paused').length)

const statCards = computed(() => [
  {
    label: '直播间总数',
    value: String(countTotal.value),
    sublines: ['全部已配置直播间'],
    tone: 'indigo',
    iconPath:
      'M6 20.25h12m-7.5-3v3m3-3v3m-10.125-3h17.25c.621 0 1.125-.504 1.125-1.125V4.875c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125Z',
  },
  {
    label: '录制中',
    value: String(countRecording.value),
    sublines: ['正在写入磁盘'],
    tone: 'emerald',
    iconPath:
      'm15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z',
  },
  {
    label: '直播中',
    value: String(countLive.value),
    sublines: ['轮询检测到开播'],
    tone: 'rose',
    iconPath:
      'M9.348 14.652a3.75 3.75 0 0 1 0-5.304m5.304 0a3.75 3.75 0 0 1 0 5.304m-7.425 2.121a6.75 6.75 0 0 1 0-9.546m9.546 0a6.75 6.75 0 0 1 0 9.546M5.106 18.894c-3.808-3.807-3.808-9.98 0-13.788m13.788 0c3.808 3.807 3.808 9.98 0 13.788M12 12h.008v.008H12V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z',
  },
  {
    label: '空闲',
    value: String(countIdle.value),
    sublines: ['当前未在录制'],
    tone: 'cyan',
    iconPath: 'M15.75 5.25v13.5m-7.5-13.5v13.5',
  },
])

const filterTabs = computed<{ key: StatusKey; label: string; count: number }[]>(() => [
  { key: 'all', label: '全部', count: countTotal.value },
  { key: 'recording', label: '录制中', count: countRecording.value },
  { key: 'idle', label: '空闲', count: countIdle.value },
  { key: 'paused', label: '已暂停', count: countPaused.value },
])

// --- 数据加载 ---
async function fetchRooms() {
  loading.value = true
  try {
    const res = await apiGet<Room[]>(`/api/rooms?page=${page.value}&limit=10`)
    rooms.value = res.data ?? []
    total.value = (res as unknown as { total?: number }).total ?? rooms.value.length
  } catch (err) {
    toast.error('加载直播间失败: ' + (err instanceof ApiError ? err.message : '未知错误'))
  } finally {
    loading.value = false
  }
}

async function fetchTemplates() {
  try {
    const res = await apiGet<UploadTemplate[]>('/api/upload_templates')
    templates.value = res.data ?? []
  } catch {
    /* ignore */
  }
}

async function fetchSettings() {
  try {
    // 2. 核心：通过 & 符号，强行把 map 混入到 ApiResponse 的最外层结构中
    // 这样 res 的类型就是 ApiResponse<unknown> & { map?: SettingsMap }
    const res = (await apiGet<unknown>('/api/settings')) as unknown & { map?: SettingsMap }

    // 3. 此时可以直接在 res 上点出 map，并且带完整类型提示
    const map = res.map ?? { downloader: 'ffmpeg' }

    if (map.downloader) {
      downloaderName.value = map.downloader
    }
  } catch (error) {
    console.error('获取设置失败:', error)
  }
}

async function refresh() {
  await Promise.all([fetchRooms(), fetchSettings()])
}

// --- 操作 ---
function openCreate() {
  editId.value = null
  editLimited.value = false
  modalVisible.value = true
}

function openEdit(room: Room, limited: boolean) {
  editId.value = room.id
  editLimited.value = limited
  modalVisible.value = true
}

function closeModal() {
  modalVisible.value = false
  editId.value = null
  editLimited.value = false
}

async function onSaved() {
  closeModal()
  await fetchRooms()
}

async function doAction(roomId: number, action: 'pause' | 'resume' | 'stop') {
  const messages: Record<string, string> = {
    pause: '确定暂停此直播间？',
    resume: '确定恢复此直播间？',
    stop: '确定停止录制？',
  }
  const ok = await confirm(messages[action], { title: `提示 #${roomId}` })
  if (!ok) return

  try {
    await apiPost(`/api/rooms/${roomId}/${action}`)
    toast.success('操作成功')
    await fetchRooms()
  } catch (err) {
    toast.error('操作失败: ' + (err instanceof ApiError ? err.message : '未知错误'))
  }
}

async function deleteRoom(roomId: number) {
  const ok = await confirm('确定删除此直播间？')
  if (!ok) return

  try {
    await apiDelete(`/api/rooms/${roomId}`)
    toast.success('删除成功')
    await fetchRooms()
  } catch (err) {
    toast.error('删除失败: ' + (err instanceof ApiError ? err.message : '未知错误'))
  }
}

function handlePageChange(p: number) {
  page.value = p
  fetchRooms()
}

// --- 工具函数 ---
function formatSegment(sec: number | null | undefined): string {
  if (!sec) return '不分段'
  if (sec >= 3600) return Math.round(sec / 3600) + 'h'
  if (sec >= 60) return Math.round(sec / 60) + 'm'
  return sec + 's'
}

const statusMeta: Record<string, { label: string; dot: string; pill: string }> = {
  idle: {
    label: '空闲',
    dot: 'bg-gray-400',
    pill: 'border-gray-200 bg-gray-50 text-gray-500',
  },
  recording: {
    label: '录制中',
    dot: 'bg-green-500 animate-pulse',
    pill: 'border-green-200 bg-green-50 text-green-700',
  },
  paused: {
    label: '已暂停',
    dot: 'bg-amber-500',
    pill: 'border-amber-200 bg-amber-50 text-amber-700',
  },
}

function statusOf(status: string) {
  return statusMeta[status] ?? statusMeta.idle
}

function roomInitial(r: Room): string {
  const name = (r.room_name || '').trim()
  if (name) return name.slice(0, 2).toUpperCase()
  try {
    return new URL(r.room_url).hostname
      .replace(/^www\./, '')
      .slice(0, 2)
      .toUpperCase()
  } catch {
    return '#'
  }
}

// --- 初始化 ---
onMounted(() => {
  fetchRooms()
  fetchTemplates()
  fetchSettings()
})
</script>

<template>
  <div class="pb-16">
    <!-- 吸顶操作栏 -->
    <header
      class="sticky top-14 z-30 -mx-4 mb-6 border-b border-gray-200/70 bg-surface/80 px-4 py-4 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold tracking-tight text-gray-900">直播间管理</h1>
          <p class="mt-0.5 text-xs text-gray-500">管理和监控所有直播间的录制状态</p>
        </div>

        <div class="flex items-center gap-2.5">
          <span
            class="hidden items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 sm:inline-flex"
          >
            <svg class="h-3.5 w-3.5 text-brand-500" fill="currentColor" viewBox="0 0 24 24">
              <path
                d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z"
              />
            </svg>
            {{ downloaderName || 'ffmpeg' }}
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
          <button
            class="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-brand-700 glow-accent"
            @click="openCreate"
          >
            <svg
              class="h-4 w-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            新增直播间
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
        :loading="loading"
      />
    </div>

    <!-- 筛选工具栏 -->
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div class="inline-flex items-center gap-1 rounded-xl border border-gray-200 bg-white p-1">
        <button
          v-for="tab in filterTabs"
          :key="tab.key"
          class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all"
          :class="
            statusFilter === tab.key
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800'
          "
          @click="statusFilter = tab.key"
        >
          {{ tab.label }}
          <span
            class="rounded-full px-1.5 py-0.5 text-[11px] leading-none tabular-nums"
            :class="
              statusFilter === tab.key ? 'bg-white/25 text-white' : 'bg-gray-100 text-gray-500'
            "
          >
            {{ tab.count }}
          </span>
        </button>
      </div>
      <span class="text-xs text-gray-400">共 {{ total }} 个直播间</span>
    </div>

    <!-- 加载骨架 -->
    <div v-if="loading" class="overflow-hidden rounded-xl hairline-card">
      <div class="flex items-center gap-4 border-b border-gray-200/70 px-4 py-3.5">
        <div class="h-3 w-10 animate-pulse rounded bg-gray-200" />
        <div class="h-3 w-24 animate-pulse rounded bg-gray-200" />
        <div class="ml-auto h-3 w-40 animate-pulse rounded bg-gray-200" />
      </div>
      <div class="divide-y divide-gray-100">
        <div v-for="n in 5" :key="n" class="flex items-center gap-4 px-4 py-4">
          <div class="h-8 w-8 animate-pulse rounded-lg bg-gray-100" />
          <div class="flex-1 space-y-2">
            <div class="h-3 w-40 animate-pulse rounded bg-gray-200" />
            <div class="h-3 w-64 animate-pulse rounded bg-gray-100" />
          </div>
          <div class="h-6 w-24 animate-pulse rounded-full bg-gray-100" />
          <div class="h-6 w-32 animate-pulse rounded bg-gray-100" />
        </div>
      </div>
    </div>

    <!-- 表格 -->
    <div v-else class="overflow-hidden rounded-xl hairline-card">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr
              class="whitespace-nowrap border-b border-gray-200/70 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400"
            >
              <th class="w-[64px] px-4 py-3">ID</th>
              <th class="px-4 py-3">直播间</th>
              <th class="w-[104px] px-4 py-3">状态</th>
              <th class="w-[150px] px-4 py-3">开关</th>
              <th class="w-[168px] px-4 py-3">轮询</th>
              <th class="px-4 py-3">配置</th>
              <th class="w-[240px] px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <!-- 空态 -->
            <tr v-if="filteredRooms.length === 0">
              <td colspan="7" class="px-4 py-16 text-center">
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
                      d="M6 20.25h12m-7.5-3v3m3-3v3m-10.125-3h17.25c.621 0 1.125-.504 1.125-1.125V4.875c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125Z"
                    />
                  </svg>
                </div>
                <p class="text-sm font-medium text-gray-500">
                  {{ statusFilter === 'all' ? '暂无直播间' : '当前筛选下没有直播间' }}
                </p>
                <p class="mt-1 text-xs text-gray-400">点击「新增直播间」开始添加你想监控的房间</p>
                <button
                  v-if="statusFilter === 'all'"
                  class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-700"
                  @click="openCreate"
                >
                  <svg
                    class="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M12 4.5v15m7.5-7.5h-15"
                    />
                  </svg>
                  新增直播间
                </button>
              </td>
            </tr>

            <tr
              v-for="r in filteredRooms"
              :key="r.id"
              class="transition-colors hover:bg-gray-50/70"
            >
              <!-- ID -->
              <td class="px-4 py-3 font-mono text-xs text-gray-400">#{{ r.id }}</td>

              <!-- 直播间 -->
              <td class="px-4 py-3">
                <div class="flex items-center gap-2.5">
                  <span
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-[11px] font-semibold text-gray-500"
                  >
                    {{ roomInitial(r) }}
                  </span>
                  <div class="min-w-0">
                    <div class="truncate font-medium text-gray-900">
                      {{ r.room_name || '未命名' }}
                    </div>
                    <a
                      :href="r.room_url"
                      target="_blank"
                      class="block max-w-[280px] truncate text-xs text-gray-400 transition-colors hover:text-brand-600"
                      :title="r.room_url"
                    >
                      {{ r.room_url }}
                    </a>
                  </div>
                </div>
              </td>

              <!-- 状态 -->
              <td class="px-4 py-3">
                <span
                  class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium"
                  :class="statusOf(r.status).pill"
                >
                  <span class="h-1.5 w-1.5 rounded-full" :class="statusOf(r.status).dot" />
                  {{ statusOf(r.status).label }}
                </span>
              </td>

              <!-- 开关 -->
              <td class="px-4 py-3">
                <div class="flex items-center gap-1.5">
                  <span
                    class="inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium transition-colors"
                    :class="
                      r.notification_enabled !== false
                        ? 'border-amber-200 bg-amber-50 text-amber-600'
                        : 'border-gray-200 text-gray-300'
                    "
                  >
                    <span
                      class="h-1.5 w-1.5 rounded-full"
                      :class="r.notification_enabled !== false ? 'bg-amber-500' : 'bg-gray-300'"
                    />
                    通知
                  </span>
                  <span
                    class="inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium transition-colors"
                    :class="
                      r.monitoring_enabled !== false
                        ? 'border-blue-200 bg-blue-50 text-blue-600'
                        : 'border-gray-200 text-gray-300'
                    "
                  >
                    <span
                      class="h-1.5 w-1.5 rounded-full"
                      :class="r.monitoring_enabled !== false ? 'bg-blue-500' : 'bg-gray-300'"
                    />
                    录制
                  </span>
                </div>
              </td>

              <!-- 轮询 -->
              <td class="px-4 py-3">
                <template v-if="r.polling_enabled">
                  <div class="mb-1.5 flex items-center gap-1.5">
                    <span class="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                    <span class="whitespace-nowrap text-xs font-medium text-green-600"
                      >轮询开启</span
                    >
                    <span class="text-xs text-gray-400">· {{ r.polling_interval }}s</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <span
                      class="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                      :class="
                        r.last_live_status ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-500'
                      "
                    >
                      <span
                        v-if="r.last_live_status"
                        class="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse"
                      />
                      {{ r.last_live_status ? '直播中' : '未开播' }}
                    </span>
                    <span class="text-[11px] text-gray-400" title="上次轮询时间">
                      {{ r.last_polled_at ? formatTime(r.last_polled_at, 'HH:mm') : '-' }}
                    </span>
                  </div>
                </template>
                <span v-else class="whitespace-nowrap text-xs text-gray-400">未开启</span>
              </td>

              <!-- 配置 -->
              <td class="px-4 py-3">
                <div class="space-y-1.5">
                  <code class="whitespace-nowrap text-xs">{{
                    r.filename_template || '{room_name}_{datetime}'
                  }}</code>
                  <div class="flex items-center gap-2 whitespace-nowrap text-[11px] text-gray-400">
                    <span>{{ formatSegment(r.segment_duration) }}</span>
                    <span class="text-gray-300">|</span>
                    <span class="truncate text-gray-500">{{
                      r.upload_template_name ||
                      (r.upload_template_id ? '#' + r.upload_template_id : '无投稿')
                    }}</span>
                  </div>
                </div>
              </td>

              <!-- 操作 -->
              <td class="px-4 py-3">
                <div class="flex items-center justify-end gap-0.5">
                  <template v-if="r.status === 'idle'">
                    <button
                      :class="[btnBase, 'text-gray-600 hover:bg-gray-100 hover:text-gray-900']"
                      @click="openEdit(r, false)"
                    >
                      <svg
                        class="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125"
                        />
                      </svg>
                      编辑
                    </button>
                    <button
                      :class="[btnBase, 'text-gray-500 hover:bg-red-50 hover:text-red-600']"
                      @click="deleteRoom(r.id)"
                    >
                      <svg
                        class="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
                        />
                      </svg>
                      删除
                    </button>
                  </template>
                  <template v-else-if="r.status === 'recording'">
                    <button
                      :class="[btnBase, 'text-gray-600 hover:bg-gray-100 hover:text-gray-900']"
                      @click="openEdit(r, true)"
                    >
                      <svg
                        class="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125"
                        />
                      </svg>
                      编辑
                    </button>
                    <button
                      :class="[btnBase, 'text-amber-600 hover:bg-amber-50']"
                      @click="doAction(r.id, 'pause')"
                    >
                      <svg
                        class="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="M15.75 5.25v13.5m-7.5-13.5v13.5"
                        />
                      </svg>
                      暂停
                    </button>
                    <button
                      :class="[btnBase, 'text-red-600 hover:bg-red-50']"
                      @click="doAction(r.id, 'stop')"
                    >
                      <svg
                        class="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z"
                        />
                      </svg>
                      停止
                    </button>
                  </template>
                  <template v-else-if="r.status === 'paused'">
                    <button
                      :class="[btnBase, 'text-gray-600 hover:bg-gray-100 hover:text-gray-900']"
                      @click="openEdit(r, true)"
                    >
                      <svg
                        class="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125"
                        />
                      </svg>
                      编辑
                    </button>
                    <button
                      :class="[btnBase, 'text-green-600 hover:bg-green-50']"
                      @click="doAction(r.id, 'resume')"
                    >
                      <svg
                        class="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="M5.25 5.653c0-.856.917-1.402 1.669-.981l11.662 6.847a1.121 1.121 0 0 1 0 1.948l-11.662 6.847a1.121 1.121 0 0 1-1.669-.981V5.653Z"
                        />
                      </svg>
                      恢复
                    </button>
                    <button
                      :class="[btnBase, 'text-red-600 hover:bg-red-50']"
                      @click="doAction(r.id, 'stop')"
                    >
                      <svg
                        class="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        viewBox="0 0 24 24"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z"
                        />
                      </svg>
                      停止
                    </button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div class="border-t border-gray-200/70 px-4 py-3">
        <Pagination :current="page" :total="total" :page-size="10" @change="handlePageChange" />
      </div>
    </div>

    <!-- 弹窗 -->
    <RoomFormModal
      :visible="modalVisible"
      :edit-id="editId"
      :limited="editLimited"
      :templates="templates"
      @close="closeModal"
      @saved="onSaved"
    />
  </div>
</template>
