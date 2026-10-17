<script setup lang="ts">
/**
 * FilePanel - 录制文件列表（懒加载）
 *
 * 首次展开时从 API 获取文件列表，展示为表格
 * 支持播放按钮（原始文件）
 */
import { ref, watch } from 'vue'
import { apiGet, ApiError } from '@/utils/api'
import { formatBytes } from '@/utils/lib'
import { useToast } from '@/utils/toast'
import type { RecordingFile } from '@/types/api'

const props = defineProps<{
  sessionId: number
  loaded?: boolean
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
let hlsPlayer: InstanceType<typeof import('hls.js').default> | null = null

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

function getFileName(fp: string) {
  return fp ? fp.split('/').pop() || '' : ''
}

async function handlePlay(file: RecordingFile) {
  if (!file.is_hls_ready) {
    toast.error('HLS 未就绪，请稍后再试')
    return
  }
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

async function openHlsPlayer(src: string) {
  const video = videoRef.value
  if (!video) return

  const { default: Hls } = await import('hls.js')

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
  <div class="border-t border-gray-200/70 bg-gray-50/40 px-4 py-3">
    <!-- Loading State -->
    <div v-if="loading" class="flex items-center justify-center gap-2 py-4">
      <div
        class="h-4 w-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"
      />
      <span class="text-sm text-gray-500">加载文件列表...</span>
    </div>

    <!-- Empty State -->
    <div v-else-if="files.length === 0" class="py-4 text-center">
      <span class="text-sm text-gray-400">无分片文件</span>
    </div>

    <!-- File Table -->
    <div v-else class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead>
          <tr
            class="border-b border-gray-200/70 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400"
          >
            <th class="py-2 pr-3">#</th>
            <th class="py-2 pr-3">文件路径</th>
            <th class="py-2 pr-3">大小</th>
            <th class="py-2 pr-3">HLS</th>
            <th class="py-2 pr-3">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(file, index) in files"
            :key="file.id"
            class="border-b border-gray-100/80 transition-colors last:border-0 hover:bg-white/60"
          >
            <td class="py-2 pr-3 font-mono tabular-nums text-gray-400">{{ index + 1 }}</td>
            <td class="max-w-[300px] break-all py-2 pr-3 font-mono text-gray-600">
              {{ file.file_path || '-' }}
            </td>
            <td class="whitespace-nowrap py-2 pr-3 tabular-nums text-gray-500">
              {{ formatBytes(file.file_size) }}
            </td>
            <td class="py-2 pr-3">
              <span
                class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                :class="
                  file.is_hls_ready
                    ? 'border-green-200 bg-green-50 text-green-700'
                    : 'border-gray-200 bg-gray-50 text-gray-500'
                "
              >
                <span
                  class="h-1.5 w-1.5 rounded-full"
                  :class="file.is_hls_ready ? 'bg-green-500' : 'bg-gray-400'"
                />
                {{ file.is_hls_ready ? '就绪' : '未生成' }}
              </span>
            </td>
            <td class="py-2 pr-3">
              <button
                v-if="file.is_hls_ready"
                class="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
                @click="handlePlay(file)"
              >
                <svg class="h-3 w-3" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M4.5 3.2a.75.75 0 0 1 1.14-.64l6.5 4.05a.75.75 0 0 1 0 1.28l-6.5 4.05a.75.75 0 0 1-1.14-.64V3.2Z"
                  />
                </svg>
                播放
              </button>
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
