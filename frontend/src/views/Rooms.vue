<script setup lang="ts">
/**
 * 直播间管理 - CRUD 操作
 *
 * - 直播间列表（分页、状态过滤）
 * - 新增/编辑弹窗
 * - 暂停/恢复/停止/删除操作
 * - 统计卡片
 */
import { ref, computed, onMounted } from 'vue'
import { apiGet, apiPost, apiDelete, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'
import Pagination from '@/components/Pagination.vue'
import RoomFormModal from './rooms/RoomFormModal.vue'
import type { Room, UploadTemplate } from '@/types/api'

interface SettingsMap {
  downloader?: string
  [key: string]: unknown
}

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
const statusFilter = ref<'all' | 'recording' | 'idle' | 'paused'>('all')

// 弹窗
const modalVisible = ref(false)
const editId = ref<number | null>(null)
const editLimited = ref(false)

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

// --- 数据加载 ---
async function fetchRooms() {
  loading.value = true
  try {
    const res = await apiGet<Room[]>(`/api/rooms?page=${page.value}&limit=50`)
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
  if (!sec) return '-'
  if (sec >= 3600) return Math.round(sec / 3600) + 'h'
  if (sec >= 60) return Math.round(sec / 60) + 'm'
  return sec + 's'
}

const statusLabels: Record<string, string> = {
  idle: '空闲',
  recording: '录制中',
  paused: '已暂停',
}

const statusDotClasses: Record<string, string> = {
  idle: 'bg-gray-400',
  recording: 'bg-green-500 animate-pulse',
  paused: 'bg-yellow-500',
}

// --- 初始化 ---
onMounted(() => {
  fetchRooms()
  fetchTemplates()
  fetchSettings()
})
</script>

<template>
  <div>
    <!-- 标题栏 -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">直播间管理</h1>
        <p class="text-sm text-gray-500 mt-1">管理和监控所有直播间的录制状态</p>
      </div>
      <div class="flex items-center gap-3">
        <span
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-100 text-blue-700 text-sm font-medium"
        >
          <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
            <path
              d="M11.251.068a.5.5 0 0 1 .227.58L9.677 6.5H13a.5.5 0 0 1 .364.843l-8 8.5a.5.5 0 0 1-.842-.49L6.323 9.5H3a.5.5 0 0 1-.364-.843l8-8.5a.5.5 0 0 1 .615-.09z"
            />
          </svg>
          {{ downloaderName }}
        </span>
        <button
          class="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors"
          @click="openCreate"
        >
          <svg
            class="w-4 h-4"
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

    <!-- 统计卡片 -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
      <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div class="flex items-center gap-3">
          <div
            class="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center text-gray-500"
          >
            <svg
              class="w-5 h-5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M6 20.25h12m-7.5-3v3m3-3v3m-10.125-3h17.25c.621 0 1.125-.504 1.125-1.125V4.875c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125Z"
              />
            </svg>
          </div>
          <div>
            <div class="text-2xl font-bold text-gray-900">{{ countTotal }}</div>
            <div class="text-xs text-gray-500">总数</div>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div class="flex items-center gap-3">
          <div
            class="w-9 h-9 rounded-lg bg-green-100 flex items-center justify-center text-green-600"
          >
            <svg
              class="w-5 h-5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
              />
            </svg>
          </div>
          <div>
            <div class="text-2xl font-bold text-gray-900">{{ countRecording }}</div>
            <div class="text-xs text-gray-500">录制中</div>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-red-100 flex items-center justify-center text-red-600">
            <svg
              class="w-5 h-5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M9.348 14.652a3.75 3.75 0 0 1 0-5.304m5.304 0a3.75 3.75 0 0 1 0 5.304m-7.425 2.121a6.75 6.75 0 0 1 0-9.546m9.546 0a6.75 6.75 0 0 1 0 9.546M5.106 18.894c-3.808-3.807-3.808-9.98 0-13.788m13.788 0c3.808 3.807 3.808 9.98 0 13.788M12 12h.008v.008H12V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
              />
            </svg>
          </div>
          <div>
            <div class="text-2xl font-bold text-gray-900">{{ countLive }}</div>
            <div class="text-xs text-gray-500">直播中</div>
          </div>
        </div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div class="flex items-center gap-3">
          <div
            class="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center text-gray-400"
          >
            <svg
              class="w-5 h-5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M15.75 5.25v13.5m-7.5-13.5v13.5"
              />
            </svg>
          </div>
          <div>
            <div class="text-2xl font-bold text-gray-900">{{ countIdle }}</div>
            <div class="text-xs text-gray-500">空闲</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 状态筛选标签 -->
    <div class="flex items-center gap-2 mb-4">
      <span class="text-sm text-gray-500 mr-1">状态:</span>
      <button
        v-for="st in ['all', 'recording', 'idle', 'paused'] as const"
        :key="st"
        class="px-3 py-1.5 text-sm font-medium rounded-lg transition-colors"
        :class="
          statusFilter === st
            ? 'bg-brand-600 text-white'
            : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
        "
        @click="statusFilter = st"
      >
        {{ { all: '全部', recording: '录制中', idle: '空闲', paused: '已暂停' }[st] }}
        <span
          v-if="st !== 'all'"
          class="ml-1 text-xs"
          :class="statusFilter === st ? 'text-brand-200' : 'text-gray-400'"
        >
          {{ { recording: countRecording, idle: countIdle, paused: countPaused }[st] }}
        </span>
      </button>
    </div>

    <!-- 加载态 -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div>
      <span class="ml-3 text-gray-500">加载中...</span>
    </div>

    <!-- 表格 -->
    <div v-else class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-[70px]">ID</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">直播间</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-[100px]">状态</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-[150px]">开关</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-[110px]">轮询</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">配置</th>
              <th class="px-4 py-3 text-right font-medium text-gray-500 w-[220px]">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <!-- 空态 -->
            <tr v-if="filteredRooms.length === 0">
              <td colspan="7" class="px-4 py-12 text-center text-gray-400">
                <svg
                  class="w-10 h-10 mx-auto mb-2 text-gray-300"
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
                暂无直播间数据
              </td>
            </tr>

            <tr v-for="r in filteredRooms" :key="r.id" class="hover:bg-gray-50 transition-colors">
              <!-- ID -->
              <td class="px-4 py-3 font-mono text-xs text-gray-400">#{{ r.id }}</td>

              <!-- 直播间 -->
              <td class="px-4 py-3">
                <div class="font-medium text-gray-900">{{ r.room_name || '-' }}</div>
                <a
                  :href="r.room_url"
                  target="_blank"
                  class="text-xs text-gray-400 hover:text-brand-600 truncate block max-w-[300px]"
                  :title="r.room_url"
                >
                  {{ r.room_url.length > 50 ? r.room_url.slice(0, 50) + '...' : r.room_url }}
                </a>
              </td>

              <!-- 状态 -->
              <td class="px-4 py-3">
                <div class="flex items-center gap-1.5">
                  <span
                    class="inline-block w-2 h-2 rounded-full"
                    :class="statusDotClasses[r.status] || 'bg-gray-400'"
                  ></span>
                  <span class="text-sm text-gray-700">{{
                    statusLabels[r.status] || r.status
                  }}</span>
                </div>
              </td>

              <!-- 开关 -->
              <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                  <span
                    class="flex items-center gap-1 text-xs"
                    :class="r.notification_enabled !== false ? 'text-amber-600' : 'text-gray-300'"
                    title="通知"
                  >
                    <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                      <path
                        d="M8 16a2 2 0 0 0 2-2H6a2 2 0 0 0 2 2zm.995-14.903a1 1 0 1 0-1.99 0A5.002 5.002 0 0 0 3 6c0 1.098-.5 6-2 7h14c-1.5-1-2-5.902-2-7 0-2.42-1.72-4.44-4.005-4.903z"
                      />
                    </svg>
                    通知
                  </span>
                  <span
                    class="flex items-center gap-1 text-xs"
                    :class="r.monitoring_enabled !== false ? 'text-blue-600' : 'text-gray-300'"
                    title="监听"
                  >
                    <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                      <path
                        d="M2 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4zm2-1a1 1 0 0 0-1 1v.217l7 4.2 7-4.2V4a1 1 0 0 0-1-1H4zm13 2.383-4.758 2.855L15 11.114v-5.73zm-.034 6.878L9.271 8.82 8 9.583 6.728 8.82l-5.694 3.44A1 1 0 0 0 2 13h12a1 1 0 0 0 .966-.739zM1 11.114l4.758-2.876L1 5.383v5.73z"
                      />
                    </svg>
                    监听
                  </span>
                </div>
              </td>

              <!-- 轮询 -->
              <td class="px-4 py-3">
                <template v-if="r.polling_enabled">
                  <div class="flex items-center gap-1.5 mb-1">
                    <span
                      class="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"
                    ></span>
                    <span class="text-xs font-medium text-green-600">轮询中</span>
                  </div>
                  <span
                    class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium"
                    :class="
                      r.last_live_status ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'
                    "
                  >
                    {{ r.last_live_status ? '直播中' : '未开播' }}
                  </span>
                </template>
                <span v-else class="text-xs text-gray-400">未开启</span>
              </td>

              <!-- 配置 -->
              <td class="px-4 py-3">
                <div class="text-xs space-y-1">
                  <code class="bg-gray-100 px-1.5 py-0.5 rounded text-gray-600 text-xs break-all">
                    {{ r.filename_template || '{room_name}_{datetime}' }}
                  </code>
                  <div class="text-gray-400 mt-2">
                    <span>{{ formatSegment(r.segment_duration) }}</span>
                    <span class="mx-1">|</span>
                    <span class="text-gray-500">{{
                      r.upload_template_name ||
                      (r.upload_template_id ? '#' + r.upload_template_id : '-')
                    }}</span>
                  </div>
                </div>
              </td>

              <!-- 操作 -->
              <td class="px-4 py-3">
                <div class="flex items-center justify-end gap-1.5">
                  <template v-if="r.status === 'idle'">
                    <button
                      class="px-2.5 py-1 text-xs font-medium rounded-md border border-blue-300 text-blue-600 hover:bg-blue-50 transition-colors"
                      @click="openEdit(r, false)"
                    >
                      编辑
                    </button>
                    <button
                      class="px-2.5 py-1 text-xs font-medium rounded-md border border-red-300 text-red-600 hover:bg-red-50 transition-colors"
                      @click="deleteRoom(r.id)"
                    >
                      删除
                    </button>
                  </template>
                  <template v-else-if="r.status === 'recording'">
                    <button
                      class="px-2.5 py-1 text-xs font-medium rounded-md border border-blue-300 text-blue-600 hover:bg-blue-50 transition-colors"
                      @click="openEdit(r, true)"
                    >
                      编辑
                    </button>
                    <button
                      class="px-2.5 py-1 text-xs font-medium rounded-md border border-amber-300 text-amber-600 hover:bg-amber-50 transition-colors"
                      @click="doAction(r.id, 'pause')"
                    >
                      暂停
                    </button>
                    <button
                      class="px-2.5 py-1 text-xs font-medium rounded-md border border-red-300 text-red-600 hover:bg-red-50 transition-colors"
                      @click="doAction(r.id, 'stop')"
                    >
                      停止
                    </button>
                  </template>
                  <template v-else-if="r.status === 'paused'">
                    <button
                      class="px-2.5 py-1 text-xs font-medium rounded-md border border-blue-300 text-blue-600 hover:bg-blue-50 transition-colors"
                      @click="openEdit(r, true)"
                    >
                      编辑
                    </button>
                    <button
                      class="px-2.5 py-1 text-xs font-medium rounded-md border border-green-300 text-green-600 hover:bg-green-50 transition-colors"
                      @click="doAction(r.id, 'resume')"
                    >
                      恢复
                    </button>
                    <button
                      class="px-2.5 py-1 text-xs font-medium rounded-md border border-red-300 text-red-600 hover:bg-red-50 transition-colors"
                      @click="doAction(r.id, 'stop')"
                    >
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
      <div class="px-4 py-3 border-t border-gray-200">
        <Pagination :current="page" :total="total" @change="handlePageChange" />
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
