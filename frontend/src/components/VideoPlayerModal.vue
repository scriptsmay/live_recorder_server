<script setup lang="ts">
/**
 * 通用视频播放弹窗
 *
 * 优先播放 HLS；HLS 未就绪（未生成 / 已过期 / 生成失败）时回退到直连流。
 * 直连流仅后端 `/api/recordings/:id/stream` 支持的 mp4 可用。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { apiGet } from '@/utils/api'
import { useToast } from '@/utils/toast'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    recordingId?: number | null
    /** 直连播放地址（recordingId 不存在或需覆盖默认 stream 地址时使用） */
    directSrc?: string | null
  }>(),
  { title: '视频播放', recordingId: null, directSrc: null },
)

const emit = defineEmits<{ (e: 'close'): void }>()

const toast = useToast()
const videoRef = ref<HTMLVideoElement | null>(null)
const src = ref('')
let hlsPlayer: InstanceType<typeof import('hls.js').default> | null = null

watch(
  () => props.open,
  (open) => {
    if (open) {
      void start()
    } else {
      teardown()
    }
  },
)

onBeforeUnmount(teardown)

async function start() {
  teardown()
  src.value = ''
  await nextTick()

  const id = props.recordingId
  if (id) {
    try {
      const res = await apiGet<{ is_ready: boolean; relative_path: string }>(
        `/api/recordings/${id}/hls`,
      )
      if (res.data?.is_ready && res.data.relative_path) {
        await attachHls(`/hls/${res.data.relative_path}`)
        return
      }
    } catch {
      // HLS 查询失败，继续尝试直连播放
    }
  }

  const direct = props.directSrc || (id ? `/api/recordings/${id}/stream` : '')
  if (!direct) {
    toast.error('无法播放：缺少视频源')
    emit('close')
    return
  }
  await attachDirect(direct)
}

async function attachDirect(url: string) {
  try {
    // 先用 Range 探测一次，避免把后端的 JSON 错误当成视频源直接塞给 <video>
    const res = await fetch(url, { headers: { Range: 'bytes=0-1' } })
    if (!res.ok && res.status !== 206) {
      let message = `视频加载失败（${res.status}）`
      if (res.headers.get('content-type')?.includes('application/json')) {
        const body = await res.json().catch(() => null)
        message = body?.message || message
      }
      toast.error(message)
      emit('close')
      return
    }
  } catch (err) {
    toast.error(err instanceof Error ? `视频加载失败：${err.message}` : '视频加载失败')
    emit('close')
    return
  }

  if (!props.open) return
  src.value = url
  await nextTick()
  videoRef.value?.play().catch((e) => {
    if (e.name !== 'AbortError') console.error('[player] play error:', e)
  })
}

async function attachHls(url: string) {
  const video = videoRef.value
  if (!video) return

  const { default: Hls } = await import('hls.js')
  if (!props.open) return

  if (Hls.isSupported()) {
    hlsPlayer = new Hls()
    hlsPlayer.loadSource(url)
    hlsPlayer.attachMedia(video)
    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch((e) => {
        if (e.name !== 'AbortError') console.error('[hls.js] play error:', e)
      })
    })
    hlsPlayer.on(Hls.Events.ERROR, (_event, data) => {
      console.error('[hls.js] Error:', data.fatal, data.type, data.details)
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hlsPlayer?.startLoad()
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            hlsPlayer?.recoverMediaError()
            break
          default:
            teardown()
            break
        }
      }
    })
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    src.value = url
    await nextTick()
    videoRef.value?.play().catch((e) => {
      if (e.name !== 'AbortError') console.error('[hls.js] play error:', e)
    })
  }
}

function teardown() {
  if (hlsPlayer) {
    hlsPlayer.destroy()
    hlsPlayer = null
  }
  const video = videoRef.value
  if (video) {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
  src.value = ''
}

function close() {
  teardown()
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div class="bg-black rounded-xl shadow-2xl w-full max-w-4xl mx-4 overflow-hidden">
        <div class="flex items-center justify-between px-4 py-2 bg-gray-900">
          <span class="text-sm text-gray-300 truncate">{{ title }}</span>
          <button class="text-gray-400 hover:text-white transition-colors" @click="close">
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
          playsinline
          class="w-full"
          style="max-height: 70vh"
          :src="src || undefined"
        />
      </div>
    </div>
  </Teleport>
</template>
