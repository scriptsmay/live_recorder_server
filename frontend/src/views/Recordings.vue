<script setup lang="ts">
/**
 * 录制文件 - 查看/播放/转码/删除录制文件
 * 从 recordings.ejs 迁移
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiGet, apiPost, apiDelete, ApiError } from '@/utils/api'
import { formatBytes } from '@/utils/lib'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'
import Pagination from '@/components/Pagination.vue'
import VideoPlayerModal from '@/components/VideoPlayerModal.vue'
import type { Room } from '@/types/api'

const toast = useToast()
const { confirm } = useConfirm()
const route = useRoute()
const router = useRouter()

interface RecordingRow {
  id: number
  session_id: number | null
  room_name: string
  room_url: string
  file_path: string
  file_size: number
  status: string
  is_hls_ready: boolean
  session_started_at: string
  session_ended_at: string | null
  started_at: string
  ended_at: string | null
  file_exists?: boolean
}

const recordings = ref<RecordingRow[]>([])
const rooms = ref<Room[]>([])
const total = ref(0)
const loading = ref(true)
const roomFilter = ref('')
const page = ref(1)

// Video player modal
const playerVisible = ref(false)
const playerRecordingId = ref<number | null>(null)
const playerTitle = ref('视频播放')
const currentRoomFilter = computed(() => (route.query.room_url as string) || '')

async function loadData() {
  loading.value = true
  roomFilter.value = currentRoomFilter.value
  try {
    const params = new URLSearchParams()
    if (roomFilter.value) params.set('room_url', roomFilter.value)
    params.set('page', String(page.value))
    params.set('limit', '10')
    const qs = params.toString() ? `?${params.toString()}` : ''
    const [recRes, roomRes] = await Promise.all([
      apiGet<{ rows: RecordingRow[]; total: number }>(`/api/recording_files${qs}`),
      apiGet<Room[] | { rows: Room[]; total: number }>('/api/rooms'),
    ])
    recordings.value = recRes.data.rows ?? []
    total.value = recRes.data.total ?? recordings.value.length

    const roomData = roomRes.data
    rooms.value = Array.isArray(roomData) ? roomData : (roomData.rows ?? [])
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '加载失败')
  } finally {
    loading.value = false
  }
}

function handlePageChange(p: number) {
  page.value = p
  loadData()
}

function handleRoomFilter(roomUrl: string) {
  page.value = 1
  router.push({ path: '/recordings', query: roomUrl ? { room_url: roomUrl } : {} })
}

function getFileName(fp: string) {
  return fp ? fp.split('/').pop() || '' : ''
}

const TRANSCODE_EXT = /\.(ts|flv|m2ts)$/i
// 后端 /api/recordings/:id/stream 仅支持 mp4 直连；其他格式必须等 HLS 就绪
const DIRECT_PLAY_EXT = /\.mp4$/i

function canPlay(rec: RecordingRow) {
  if (rec.status !== 'completed' || !rec.file_path) return false
  return rec.is_hls_ready || DIRECT_PLAY_EXT.test(rec.file_path)
}

function handlePlay(rec: RecordingRow) {
  playerRecordingId.value = rec.id
  playerTitle.value = getFileName(rec.file_path) || '视频播放'
  playerVisible.value = true
}

async function handleTranscode(rec: RecordingRow) {
  const filename = getFileName(rec.file_path)
  const ok = await confirm(`确定将文件加入转码队列？`, { title: filename })
  if (!ok) return
  try {
    const res = await apiPost(`/api/recordings/${rec.id}/transcode`)
    toast.success((res as unknown as { message?: string }).message || '已加入转码队列')
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '转码失败')
  }
}

async function handleReencode(rec: RecordingRow) {
  const filename = getFileName(rec.file_path)
  const ok = await confirm(
    `将该 HEVC 文件重新编码为 H.264，浏览器可播、B 站可投稿。转码先写入临时文件、成功后替换源文件，失败不影响原文件。确定？`,
    { title: filename },
  )
  if (!ok) return
  try {
    const res = await apiPost(`/api/recordings/${rec.id}/reencode`)
    toast.success((res as unknown as { message?: string }).message || '已加入重新转码队列')
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '重新转码失败')
  }
}

async function handleDelete(rec: RecordingRow) {
  const filename = getFileName(rec.file_path)
  const ok = await confirm(`确定删除此录制记录？${filename ? '\n' + filename : ''}`, {
    title: `#${rec.id}`,
  })
  if (!ok) return
  try {
    await apiDelete(`/api/recordings/${rec.id}`)
    toast.success('已删除记录')
    loadData()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '删除失败')
  }
}

function statusStyle(status: string) {
  const statusStyleMap: Record<string, string> = {
    completed: 'bg-green-100 text-green-700',
    recording: 'bg-blue-100 text-blue-700',
    interrupted: 'bg-red-100 text-red-700',
    deleted: 'bg-stone-100 text-stone-500',
    missing: 'bg-gray-100 text-gray-500',
  }
  return statusStyleMap[status] || 'bg-gray-100 text-gray-600'
}

function statusLabel(status: string) {
  return (
    {
      completed: '已完成',
      recording: '录制中',
      interrupted: '中断',
      deleted: '已删除',
      missing: '已丢失',
    }[status] || status
  )
}

onMounted(loadData)

watch(
  () => route.query.room_url,
  () => {
    loadData()
  },
)
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900">录制文件</h1>
      <span class="text-sm text-gray-500">共 {{ total }} 条记录</span>
    </div>

    <!-- Room filter -->
    <div class="bg-white rounded-xl border border-gray-200 p-4 mb-4 shadow-sm">
      <div class="flex items-center flex-wrap gap-2">
        <span class="text-sm text-gray-500 shrink-0">直播间：</span>
        <button
          class="px-3 py-1 text-xs font-medium rounded-full transition-colors"
          :class="
            !roomFilter ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          "
          @click="handleRoomFilter('')"
        >
          全部
        </button>
        <button
          v-for="r in rooms"
          :key="r.id"
          class="px-3 py-1 text-xs font-medium rounded-full transition-colors"
          :class="
            roomFilter === r.room_url
              ? 'bg-brand-600 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          "
          @click="handleRoomFilter(r.room_url)"
        >
          {{ r.room_name || '直播间' }}
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center py-12">
      <div
        class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"
      />
      <span class="text-sm text-gray-500">加载中...</span>
    </div>

    <!-- Empty -->
    <div
      v-else-if="recordings.length === 0"
      class="bg-white rounded-xl border border-gray-200 p-12 text-center shadow-sm"
    >
      <p class="text-sm text-gray-400">暂无录制记录</p>
    </div>

    <!-- Table -->
    <div v-else class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-16">ID</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500 whitespace-nowrap">
                直播间会话
              </th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">文件路径</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-30">大小</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-24">状态</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-40">开始时间</th>
              <th class="px-4 py-3 text-right font-medium text-gray-500 w-50">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="rec in recordings" :key="rec.id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3 font-mono text-xs text-gray-400">{{ rec.id }}</td>
              <td class="px-4 py-3">
                <span class="font-medium text-gray-900 min-w-[60px]">
                  {{ rec.room_name || '-' }}
                </span>
                <router-link
                  v-if="rec.session_id"
                  :to="'/sessions'"
                  class="font-mono text-xs text-gray-500 hover:text-brand-600"
                >
                  #{{ rec.session_id }}
                </router-link>
              </td>
              <td
                class="px-4 py-3 text-xs text-gray-500 break-all min-w-[200px] max-w-[250px]"
                :title="rec.file_path"
              >
                {{ rec.file_path || '-' }}
              </td>
              <td class="px-4 py-3 text-xs text-gray-500">{{ formatBytes(rec.file_size) }}</td>
              <td class="px-4 py-3 whitespace-nowrap">
                <span
                  class="inline-block px-2 py-0.5 rounded-full text-xs font-medium min-w-[50px] text-center"
                  :class="statusStyle(rec.status)"
                >
                  {{ statusLabel(rec.status) }}
                </span>
              </td>
              <td class="px-4 py-3 text-xs text-gray-500">
                {{ $formatTime(rec.session_started_at || rec.started_at) }}
              </td>
              <td class="px-4 py-3 text-right">
                <div class="flex items-center justify-end gap-1.5">
                  <button
                    v-if="canPlay(rec)"
                    class="px-2 py-1 text-xs rounded border border-sky-300 text-sky-600 hover:bg-sky-50 transition-colors"
                    title="播放"
                    @click="handlePlay(rec)"
                  >
                    ▶
                  </button>
                  <button
                    v-if="
                      rec.status === 'completed' &&
                      rec.file_path &&
                      TRANSCODE_EXT.test(rec.file_path)
                    "
                    class="px-2 py-1 text-xs rounded border border-amber-300 text-amber-600 hover:bg-amber-50 transition-colors"
                    @click="handleTranscode(rec)"
                  >
                    转码
                  </button>
                  <button
                    v-if="
                      rec.status === 'completed' &&
                      rec.file_path &&
                      DIRECT_PLAY_EXT.test(rec.file_path)
                    "
                    class="px-2 py-1 text-xs rounded border border-violet-300 text-violet-600 hover:bg-violet-50 transition-colors"
                    title="HEVC→H.264"
                    @click="handleReencode(rec)"
                  >
                    重转H264
                  </button>
                  <button
                    class="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 transition-colors"
                    @click="handleDelete(rec)"
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div class="px-4 py-3 border-t border-gray-200">
        <Pagination :current="page" :total="total" :page-size="10" @change="handlePageChange" />
      </div>
    </div>

    <!-- Video Player Modal -->
    <VideoPlayerModal
      :open="playerVisible"
      :recording-id="playerRecordingId"
      :title="playerTitle"
      @close="playerVisible = false"
    />
  </div>
</template>
