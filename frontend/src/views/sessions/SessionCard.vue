<script setup lang="ts">
/**
 * SessionCard - 单个录制会话卡片
 *
 * 双栏布局：左栏直播录制信息，右栏弹幕信息
 * 支持展开文件列表（懒加载）、查看投稿记录、删除、投稿
 */
import { ref, computed, onMounted } from 'vue'
import { apiGet } from '@/utils/api'
import { formatBytes } from '@/utils/lib'
import { useToast } from '@/utils/toast'
import FilePanel from './FilePanel.vue'
import type { RecordingSession, UploadRecord, UploadTemplate } from '@/types/api'

const props = defineProps<{
  session: RecordingSession
  templates: UploadTemplate[]
}>()

const emit = defineEmits<{
  'delete-session': [sessionId: number]
  upload: [sessionId: number]
}>()

const toast = useToast()

// ---- Local State ----
const filesExpanded = ref(false)
const uploadRecords = ref<UploadRecord[]>([])

// ---- Computed ----
const isDone = computed(
  () => props.session.status === 'completed' || props.session.status === 'interrupted',
)

const hasSuccessUpload = computed(() => uploadRecords.value.some((u) => u.status === 'success'))

const sessionBadge = computed(() => {
  const s = props.session
  switch (s.status) {
    case 'recording':
      return {
        text: '录制中',
        cls: 'bg-green-100 text-green-700',
        dotCls: 'bg-green-500 animate-pulse',
      }
    case 'completed':
      return { text: '已完成', cls: 'bg-blue-100 text-blue-700', dotCls: 'bg-blue-500' }
    case 'interrupted':
      return { text: '中断', cls: 'bg-red-100 text-red-700', dotCls: 'bg-red-500' }
    default:
      return { text: '准备中', cls: 'bg-gray-100 text-gray-500', dotCls: 'bg-gray-400' }
  }
})

const danmakuBadge = computed(() => {
  const s = props.session
  const count = s.danmaku_event_count || 0
  switch (s.danmaku_status) {
    case 'recording':
      return { text: `录制中 (${count}条)`, cls: 'bg-blue-100 text-blue-700' }
    case 'completed':
      return { text: `已完成 (${count}条)`, cls: 'bg-green-100 text-green-700' }
    case 'failed':
      return { text: '失败', cls: 'bg-red-100 text-red-600' }
    default:
      return { text: '\u2014', cls: 'bg-gray-100 text-gray-500' }
  }
})

const truncatedStreamUrl = computed(() => {
  const url = props.session.stream_url || ''
  if (url.length <= 100) return url
  return url.slice(0, 100) + '\u2026'
})

const logFileUrl = computed(() => {
  const downloader = 'ffmpeg'
  const filename = encodeURIComponent(`${downloader}_${props.session.id}.log`)
  return `/logs?file=${filename}`
})

const uploadBadgeCls = (status: string) => {
  switch (status) {
    case 'success':
      return 'bg-green-100 text-green-700'
    case 'uploading':
      return 'bg-blue-100 text-blue-700'
    case 'failed':
      return 'bg-red-100 text-red-600'
    default:
      return 'bg-gray-100 text-gray-500'
  }
}

// ---- Helpers ----

// 统一的成功提示函数（可以对接你上一问的 Bootstrap Toast）
function handleCopySuccess(text: string) {
  console.log('复制成功:', text)
  // 如果你有 toast 函数，可以在这里调用：
  toast.success('已复制直播流地址')
}
async function copyStreamUrl() {
  const url = props.session.stream_url
  if (!url) return
  // 1. 优先使用现代的 Clipboard API（如果是 HTTPS 或 Localhost）
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(url)
      .then(() => handleCopySuccess(url))
      .catch((err) => console.error('现代复制API失败:', err))
  } else {
    // 2. 降级方案：针对 HTTP 环境或老旧浏览器
    // 创建一个隐藏的 input 元素
    const textArea = document.createElement('textarea')
    textArea.value = url

    // 避开滚动条影响，将其定位到屏幕外
    textArea.style.position = 'fixed'
    textArea.style.top = '-9999px'
    document.body.appendChild(textArea)

    // 选中文字并执行复制命令
    textArea.focus()
    textArea.select()

    try {
      const successful = document.execCommand('copy')
      if (successful) {
        handleCopySuccess(url)
      } else {
        toast.error('复制失败')
      }
    } catch (err) {
      console.error('降级复制方案失败:', err)
    }

    // 移除临时创建的元素
    document.body.removeChild(textArea)
  }

  // try {
  //   await navigator.clipboard.writeText(url)
  //   toast.success('已复制直播流地址')
  // } catch (err) {
  //   console.error('复制直播流地址失败', err)
  //   toast.error('复制失败')
  // }
}

// ---- Lifecycle ----
onMounted(async () => {
  // Fetch upload records for this session
  try {
    const res = await apiGet<{ rows: UploadRecord[]; total: number }>(
      `/api/upload_records?session_id=${props.session.id}`,
    )
    uploadRecords.value = res.data?.rows || []
  } catch {
    // silently ignore
  }
})
</script>

<template>
  <div
    class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-3 hover:shadow-md transition-shadow"
  >
    <!-- Card Header -->
    <div class="flex items-center gap-2.5 px-4 py-3 border-b border-amber-100 flex-wrap">
      <span
        class="inline-flex items-center bg-brand-600 text-white text-xs font-bold px-2 py-0.5 rounded-md shrink-0"
      >
        #{{ session.id }}
      </span>
      <strong class="text-sm font-semibold text-gray-900 min-w-0 truncate flex-1">
        {{ session.room_name || session.room_url || '未命名' }}
      </strong>
      <small class="text-xs text-gray-400 truncate max-w-[200px]" :title="session.room_url || ''">
        {{ session.room_url || '' }}
      </small>
      <span
        class="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full shrink-0"
        :class="sessionBadge.cls"
      >
        <span class="w-2 h-2 rounded-full" :class="sessionBadge.dotCls" />
        {{ sessionBadge.text }}
      </span>
      <button
        class="px-2 py-0.5 text-xs font-medium rounded border border-red-300 text-red-500 hover:bg-red-50 transition-colors shrink-0"
        title="删除会话"
        @click="emit('delete-session', session.id)"
      >
        删除
      </button>
    </div>

    <!-- Card Body: Two-Column -->
    <div class="flex flex-col md:flex-row">
      <!-- Left Column: Recording Info -->
      <div class="flex-1 p-4 border-b md:border-b-0 md:border-r border-gray-100">
        <!-- Section Header -->
        <div class="flex items-center gap-1.5 mb-3 text-amber-500">
          <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
            <path
              fill-rule="evenodd"
              d="M0 5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.983 1.738l3.11-1.382A1 1 0 0 1 16 4.269v7.462a1 1 0 0 1-1.406.913l-3.111-1.382A2 2 0 0 1 9.5 13H2a2 2 0 0 1-2-2zm11.5 5.175 3.5 1.556V4.269l-3.5 1.556zM2 4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z"
            />
          </svg>
          <span class="text-sm font-medium">(直播录制)</span>
          <span v-if="session.caption" class="text-xs ml-2">{{ session.caption }}</span>
        </div>

        <!-- Info Grid -->
        <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <span class="text-gray-400">开始时间</span>
            <div class="text-gray-700 mt-0.5">{{ $formatTime(session.started_at) }}</div>
          </div>
          <div>
            <span class="text-gray-400">结束时间</span>
            <div class="text-gray-700 mt-0.5">{{ $formatTime(session.ended_at) }}</div>
          </div>
          <div>
            <span class="text-gray-400">分片数</span>
            <div class="text-gray-700 mt-0.5">{{ session.total_segments || 0 }} 段</div>
          </div>
          <div>
            <span class="text-gray-400">文件大小</span>
            <div class="text-gray-700 mt-0.5">{{ formatBytes(session.total_size) }}</div>
          </div>
          <div class="col-span-2">
            <span class="text-gray-400">输出路径</span>
            <div class="text-gray-700 mt-0.5 break-all">{{ session.output_path || '-' }}</div>
          </div>
          <div class="col-span-2">
            <span class="text-gray-400">直播流</span>
            <code
              class="block text-gray-600 bg-gray-50 rounded px-2 py-1 mt-0.5 text-xs cursor-pointer hover:bg-gray-100 break-all"
              :title="session.stream_url || ''"
              @click="copyStreamUrl"
              >{{ truncatedStreamUrl || '-' }}</code
            >
          </div>
        </div>

        <!-- Upload Records -->
        <div v-if="uploadRecords.length > 0" class="mt-3">
          <span class="text-xs text-gray-400 block mb-1">投稿记录</span>
          <div class="flex flex-wrap gap-1">
            <span
              v-for="u in uploadRecords"
              :key="u.id"
              class="text-xs font-medium px-2 py-0.5 rounded-full"
              :class="uploadBadgeCls(u.status)"
              :title="u.status"
            >
              {{ u.bv_id ? 'BV ' + u.bv_id : u.status }}
            </span>
          </div>
        </div>

        <!-- Left Actions -->
        <div class="flex items-center flex-wrap gap-1.5 mt-3 pt-2 border-t border-gray-100">
          <button
            class="flex items-center px-2.5 py-1 text-xs font-medium rounded-md border transition-colors"
            :class="
              filesExpanded
                ? 'border-brand-300 text-brand-700 bg-brand-50'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            "
            @click="filesExpanded = !filesExpanded"
          >
            <span>文件</span>
            <svg
              v-if="!filesExpanded"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              class="size-3"
            >
              <path
                fill-rule="evenodd"
                d="M8 2a.75.75 0 0 1 .75.75v8.69l3.22-3.22a.75.75 0 1 1 1.06 1.06l-4.5 4.5a.75.75 0 0 1-1.06 0l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.22 3.22V2.75A.75.75 0 0 1 8 2Z"
                clip-rule="evenodd"
              />
            </svg>

            <svg
              v-else
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              class="size-3"
            >
              <path
                fill-rule="evenodd"
                d="M8 14a.75.75 0 0 1-.75-.75V4.56L4.03 7.78a.75.75 0 0 1-1.06-1.06l4.5-4.5a.75.75 0 0 1 1.06 0l4.5 4.5a.75.75 0 0 1-1.06 1.06L8.75 4.56v8.69A.75.75 0 0 1 8 14Z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
          <a
            :href="logFileUrl"
            target="_blank"
            class="flex items-center px-2.5 py-1 text-xs font-medium rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors no-underline"
          >
            <span>日志</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              class="size-4"
            >
              <path
                d="M6.22 8.72a.75.75 0 0 0 1.06 1.06l5.22-5.22v1.69a.75.75 0 0 0 1.5 0v-3.5a.75.75 0 0 0-.75-.75h-3.5a.75.75 0 0 0 0 1.5h1.69L6.22 8.72Z"
              />
              <path
                d="M3.5 6.75c0-.69.56-1.25 1.25-1.25H7A.75.75 0 0 0 7 4H4.75A2.75 2.75 0 0 0 2 6.75v4.5A2.75 2.75 0 0 0 4.75 14h4.5A2.75 2.75 0 0 0 12 11.25V9a.75.75 0 0 0-1.5 0v2.25c0 .69-.56 1.25-1.25 1.25h-4.5c-.69 0-1.25-.56-1.25-1.25v-4.5Z"
              />
            </svg>
          </a>
          <button
            v-if="isDone && !hasSuccessUpload"
            class="px-2.5 py-1 text-xs font-medium rounded-md border border-green-300 text-green-700 hover:bg-green-50 transition-colors"
            title="投稿此会话"
            @click="emit('upload', session.id)"
          >
            投稿
          </button>
        </div>
      </div>

      <!-- Right Column: Danmaku Info -->
      <div class="flex-1 p-4">
        <!-- Section Header (green themed) -->
        <div class="flex items-center gap-1.5 mb-3">
          <svg class="w-3.5 h-3.5 text-green-500" fill="currentColor" viewBox="0 0 16 16">
            <path
              d="M5 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0m4 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0m3 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2"
            />
            <path
              d="m2.165 15.803.02-.004c1.83-.363 2.948-.842 3.468-1.105A9 9 0 0 0 8 15c4.418 0 8-3.134 8-7s-3.582-7-8-7-8 3.134-8 7c0 1.76.743 3.37 1.97 4.6a10.4 10.4 0 0 1-.524 2.318l-.003.011a11 11 0 0 1-.244.637c-.079.186.074.394.272.362a22 22 0 0 0 .693-.125Z"
            />
          </svg>
          <span class="text-sm font-medium text-green-700">弹幕信息</span>
        </div>

        <!-- Danmaku Info Grid -->
        <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <span class="text-gray-400">弹幕状态</span>
            <div class="mt-0.5">
              <span
                class="text-xs font-medium px-2 py-0.5 rounded-full"
                :class="danmakuBadge.cls"
                :title="session.danmaku_error || ''"
                >{{ danmakuBadge.text }}</span
              >
            </div>
          </div>
        </div>

        <!-- Right Actions -->
        <div class="flex items-center flex-wrap gap-1.5 mt-3 pt-2 border-t border-gray-100">
          <router-link
            :to="`/sessions/${session.id}/danmaku`"
            class="px-2.5 py-1 text-xs font-medium rounded-md border border-blue-300 text-blue-700 hover:bg-blue-50 transition-colors no-underline"
          >
            弹幕详情
          </router-link>
        </div>
      </div>
    </div>

    <!-- Collapsible File Panel (lazy loaded) -->
    <FilePanel v-if="filesExpanded" :session-id="session.id" />
  </div>
</template>
