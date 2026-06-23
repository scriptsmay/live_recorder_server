<script setup lang="ts">
/**
 * FilePanel - 录制文件列表（懒加载）
 *
 * 首次展开时从 API 获取文件列表，展示为表格
 * 支持播放按钮（原始文件和弹幕压制版）
 */
import { ref, watch } from 'vue'
import Hls from 'hls.js'
import { apiGet, ApiError } from '@/utils/api'
import { formatBytes } from '@/utils/lib'
import { useToast } from '@/utils/toast'
import type { RecordingFile } from '@/types/api'

const props = defineProps<{
  sessionId: number
  loaded: boolean
}>()

const emit = defineEmits<{
  loaded: []
}>()

const toast = useToast()

const files = ref<RecordingFile[]>([])
const loading = ref(false)

// Video player modal
const playerVisible = ref(false)
const playerSrc = ref('')
const playerTitle = ref('视频播放')
const videoRef = ref<HTMLVideoElement | null>(null)
let hlsPlayer: Hls | null = null

async function fetchFiles() {
  loading.value = true
  try {
    const res = await apiGet<{ rows: RecordingFile[]; total: number }>(
      `/api/recording_files?session_id=${props.sessionId}`,
    )
    const data = res.data
    files.value = Array.isArray(data) ? data : (data?.rows ?? [])
    emit('loaded')
  } catch (err) {
    toast.error('加载文件列表失败: ' + (err instanceof ApiError ? err.message : String(err)))
  } finally {
    loading.value = false
  }
}

// Trigger fetch on first mount if not yet loaded
if (!props.loaded) {
  fetchFiles()
}

watch(
  () => props.loaded,
  (newVal) => {
    if (newVal && files.value.length === 0) {
      // Parent says loaded but we have no data - re-fetch
      fetchFiles()
    }
  },
)

const fileStatusBadge = (status: string) => {
  switch (status) {
    case 'completed':
      return { text: '完成', cls: 'bg-green-100 text-green-700' }
    case 'recording':
      return { text: '录制中', cls: 'bg-blue-100 text-blue-700' }
    default:
      return { text: status || '-', cls: 'bg-gray-100 text-gray-500' }
  }
}

function getFileName(fp: string) {
  return fp ? fp.split('/').pop() || '' : ''
}

async function handlePlay(file: RecordingFile) {
  playerTitle.value = getFileName(file.file_path) || '视频播放'
  playerSrc.value = ''
  playerVisible.value = true

  try {
    const hlsRes = await apiGet<{ is_ready: boolean; relative_path: string }>(
      `/api/recordings/${file.id}/hls`,
    )
    if (hlsRes.data?.is_ready) {
      openHlsPlayer(`/hls/${hlsRes.data.relative_path}`)
      return
    }
  } catch {
    // HLS 检查失败，继续尝试普通播放
  }

  playerSrc.value = `/api/recordings/${file.id}/stream`
}

async function handlePlayDanmaku(file: RecordingFile) {
  playerTitle.value = getFileName(file.file_path) + ' (弹幕版)'
  playerSrc.value = `/api/recordings/${file.id}/stream?type=danmaku`
  playerVisible.value = true
}

function openHlsPlayer(src: string) {
  const video = videoRef.value
  if (!video) return

  closeHlsPlayer()

  if (Hls.isSupported()) {
    hlsPlayer = new Hls()
    hlsPlayer.loadSource(src)
    hlsPlayer.attachMedia(video)
    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch((e) => {
        if (e.name !== 'AbortError') console.error('[hls.js] play error:', e)
      })
    })
    hlsPlayer.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hlsPlayer?.startLoad()
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            hlsPlayer?.recoverMediaError()
            break
          default:
            closeHlsPlayer()
            break
        }
      }
    })
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src
    video.addEventListener('loadedmetadata', () => {
      video.play().catch((e) => {
        if (e.name !== 'AbortError') console.error('[hls.js] play error:', e)
      })
    })
  }
}

function closeHlsPlayer() {
  if (hlsPlayer) {
    hlsPlayer.destroy()
    hlsPlayer = null
  }
}

function closePlayer() {
  const video = videoRef.value
  if (video) {
    video.pause()
    video.src = ''
  }
  closeHlsPlayer()
  playerVisible.value = false
}
</script>

<template>
  <div class="border-t border-gray-200 bg-gray-50 px-4 py-3">
    <!-- Loading State -->
    <div v-if="loading" class="flex items-center gap-2 py-4 justify-center">
      <div
        class="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"
      />
      <span class="text-sm text-gray-500">加载文件列表...</span>
    </div>

    <!-- Empty State -->
    <div v-else-if="files.length === 0" class="text-center py-4">
      <span class="text-sm text-gray-400">无分片文件</span>
    </div>

    <!-- File Table -->
    <div v-else class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead>
          <tr class="text-left text-gray-400 border-b border-gray-200">
            <th class="py-1.5 pr-3 font-medium">#</th>
            <th class="py-1.5 pr-3 font-medium">文件路径</th>
            <th class="py-1.5 pr-3 font-medium">大小</th>
            <th class="py-1.5 pr-3 font-medium">HLS</th>
            <th class="py-1.5 pr-3 font-medium">弹幕</th>
            <th class="py-1.5 pr-3 font-medium">状态</th>
            <th class="py-1.5 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(file, index) in files"
            :key="file.id"
            class="border-b border-gray-100 last:border-0"
          >
            <td class="py-1.5 pr-3 text-gray-500">{{ index + 1 }}</td>
            <td class="py-1.5 pr-3 text-gray-700 break-all max-w-[300px]">
              {{ file.file_path || '-' }}
            </td>
            <td class="py-1.5 pr-3 text-gray-500 whitespace-nowrap">
              {{ formatBytes(file.file_size) }}
            </td>
            <td class="py-1.5 pr-3">
              <span
                class="px-1.5 py-0.5 rounded text-xs font-medium"
                :class="
                  file.is_hls_ready ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                "
              >
                {{ file.is_hls_ready ? '就绪' : '未生成' }}
              </span>
            </td>
            <td class="py-1.5 pr-3">
              <span
                v-if="file.is_danmaku_burned"
                class="px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700"
                >已压制</span
              >
              <span
                v-else-if="file.danmaku_ass_exists"
                class="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700"
                >ASS</span
              >
              <span
                v-else
                class="px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500"
                >无</span
              >
            </td>
            <td class="py-1.5 pr-3">
              <span
                class="px-1.5 py-0.5 rounded text-xs font-medium"
                :class="fileStatusBadge(file.status).cls"
                >{{ fileStatusBadge(file.status).text }}</span
              >
            </td>
            <td class="py-1.5 whitespace-nowrap">
              <template v-if="file.file_exists">
                <button
                  class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border border-blue-300 text-blue-700 hover:bg-blue-50 transition-colors mr-1"
                  title="播放"
                  @click="handlePlay(file)"
                >
                  &#9654;
                </button>
                <button
                  v-if="file.is_danmaku_burned"
                  class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border border-green-300 text-green-700 hover:bg-green-50 transition-colors"
                  title="播放弹幕压制版"
                  @click="handlePlayDanmaku(file)"
                >
                  &#9654;弹幕
                </button>
              </template>
              <span v-else class="text-gray-400">已删除</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Video Player Modal -->
  <Teleport to="body">
    <div
      v-if="playerVisible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div class="bg-black rounded-xl shadow-2xl w-full max-w-4xl mx-4 overflow-hidden">
        <div class="flex items-center justify-between px-4 py-2 bg-gray-900">
          <span class="text-sm text-gray-300 truncate">{{ playerTitle }}</span>
          <button class="text-gray-400 hover:text-white transition-colors" @click="closePlayer">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <video
          ref="videoRef"
          controls
          autoplay
          class="w-full"
          style="max-height: 70vh"
          :src="playerSrc"
        />
      </div>
    </div>
  </Teleport>
</template>
