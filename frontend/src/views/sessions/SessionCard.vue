<script setup lang="ts">
/**
 * SessionCard - 单个录制会话卡片
 *
 * 左栏直播录制信息（封面、分片统计、输出路径、直播流、投稿记录），
 * 右栏弹幕采集概览（事件数 + 弹幕详情 / 文件 / 日志）。
 * 支持展开文件列表（懒加载）、投稿、删除。
 *
 * 设计：Linear Aesthetic —— 超细描边卡片 + 状态 pill + 图标化 ghost 操作；
 * 全部使用语义色类（gray-* / brand-* / hairline-card），自动适配亮/深双主题。
 */
import { ref, computed, watch } from 'vue'
import { formatBytes, formatTime } from '@/utils/lib'
import { useToast } from '@/utils/toast'
import FilePanel from './FilePanel.vue'
import type { RecordingSession, UploadTemplate } from '@/types/api'

const props = defineProps<{
  session: RecordingSession
  templates: UploadTemplate[]
}>()

const emit = defineEmits<{
  'delete-session': [sessionId: number]
  upload: [sessionId: number]
}>()

const toast = useToast()

const btnGhost =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors'

// ---- Local State ----
const filesExpanded = ref(false)
const coverLoadFailed = ref(false)

watch([() => props.session.id, () => props.session.cover_path], () => {
  coverLoadFailed.value = false
})

const coverUrl = computed(() => {
  if (!props.session.cover_path || coverLoadFailed.value) return null
  return `/api/sessions/${props.session.id}/cover`
})

function handleCoverError() {
  coverLoadFailed.value = true
}

// ---- Computed ----
const uploadRecords = computed(() => props.session.upload_records ?? [])

const isDone = computed(
  () => props.session.status === 'completed' || props.session.status === 'interrupted',
)

const hasSuccessUpload = computed(() => uploadRecords.value.some((u) => u.status === 'success'))

const sessionBadge = computed(() => {
  switch (props.session.status) {
    case 'recording':
      return {
        text: '录制中',
        pill: 'border-green-200 bg-green-50 text-green-700',
        dot: 'bg-green-500 animate-pulse',
      }
    case 'completed':
      return {
        text: '已完成',
        pill: 'border-blue-200 bg-blue-50 text-blue-600',
        dot: 'bg-blue-500',
      }
    case 'interrupted':
      return {
        text: '中断',
        pill: 'border-red-200 bg-red-50 text-red-600',
        dot: 'bg-red-500',
      }
    default:
      return {
        text: '准备中',
        pill: 'border-gray-200 bg-gray-50 text-gray-500',
        dot: 'bg-gray-400',
      }
  }
})

const danmakuBadge = computed(() => {
  switch (props.session.danmaku_status) {
    case 'recording':
      return { text: '采集中', pill: 'border-green-200 bg-green-50 text-green-700' }
    case 'completed':
      return { text: '已完成', pill: 'border-blue-200 bg-blue-50 text-blue-600' }
    case 'failed':
      return { text: '采集失败', pill: 'border-red-200 bg-red-50 text-red-600' }
    default:
      return { text: '未采集', pill: 'border-gray-200 bg-gray-50 text-gray-500' }
  }
})

const truncatedStreamUrl = computed(() => {
  const url = props.session.stream_url || ''
  if (url.length <= 100) return url
  return url.slice(0, 100) + '\u2026'
})

const logFileUrl = computed(() => {
  return `/logs?file=${encodeURIComponent(`ffmpeg_${props.session.id}.log`)}`
})

function uploadPill(status: string) {
  switch (status) {
    case 'success':
      return 'border-green-200 bg-green-50 text-green-700'
    case 'uploading':
      return 'border-blue-200 bg-blue-50 text-blue-600'
    case 'failed':
      return 'border-red-200 bg-red-50 text-red-600'
    default:
      return 'border-gray-200 bg-gray-50 text-gray-500'
  }
}

const metaItems = computed(() => [
  {
    label: '开始',
    value: formatTime(props.session.started_at, 'MM-DD HH:mm'),
  },
  {
    label: '结束',
    value: formatTime(props.session.ended_at, 'MM-DD HH:mm'),
  },
  {
    label: '分片',
    value: `${props.session.total_segments || 0} 段`,
  },
  {
    label: '大小',
    value: formatBytes(props.session.total_size),
  },
])

// ---- Helpers ----
async function copyStreamUrl() {
  const url = props.session.stream_url
  if (!url) return

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success('已复制直播流地址'))
      .catch((err) => console.error('现代复制API失败:', err))
    return
  }

  const textArea = document.createElement('textarea')
  textArea.value = url
  textArea.style.position = 'fixed'
  textArea.style.top = '-9999px'
  document.body.appendChild(textArea)

  textArea.focus()
  textArea.select()

  try {
    if (document.execCommand('copy')) {
      toast.success('已复制直播流地址')
    } else {
      toast.error('复制失败')
    }
  } catch (err) {
    console.error('降级复制方案失败:', err)
    toast.error('复制失败')
  }

  document.body.removeChild(textArea)
}
</script>

<template>
  <article class="hairline-card mb-3 overflow-hidden rounded-xl">
    <!-- 卡片头部 -->
    <header
      class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-200/70 px-4 py-3"
    >
      <span
        class="inline-flex h-6 shrink-0 items-center rounded-md border border-gray-200 bg-gray-50 px-1.5 font-mono text-[11px] font-medium text-gray-500"
      >
        #{{ session.id }}
      </span>

      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <h3 class="truncate text-sm font-semibold tracking-tight text-gray-900">
            {{ session.room_name || session.room_url || '未命名' }}
          </h3>
          <span
            class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium"
            :class="sessionBadge.pill"
          >
            <span class="h-1.5 w-1.5 rounded-full" :class="sessionBadge.dot" />
            {{ sessionBadge.text }}
          </span>
        </div>
        <div class="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-gray-400">
          <span class="truncate" :title="session.room_url || ''">{{ session.room_url || '' }}</span>
          <span v-if="session.caption" class="shrink-0">· {{ session.caption }}</span>
        </div>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <button
          v-if="isDone && !hasSuccessUpload"
          :class="[btnGhost, 'text-green-600 hover:border-green-200 hover:bg-green-50']"
          title="投稿此会话"
          @click="emit('upload', session.id)"
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
              d="M12 16.5V4.5m0 0L7.5 9M12 4.5 16.5 9M3.75 19.5h16.5"
            />
          </svg>
          投稿
        </button>
        <button
          :class="[
            btnGhost,
            'text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600',
          ]"
          title="删除会话"
          @click="emit('delete-session', session.id)"
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
      </div>
    </header>

    <!-- 卡片主体 -->
    <div class="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.75fr)_minmax(264px,1fr)]">
      <!-- 左栏：录制信息 -->
      <div class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-[132px_minmax(0,1fr)]">
        <!-- 封面 -->
        <a
          v-if="coverUrl"
          :href="coverUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="group/cover relative block aspect-video self-start overflow-hidden rounded-lg border border-gray-200 bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          :aria-label="`在会话 #${session.id} 的新标签页查看封面原图`"
          title="在新标签页查看封面原图"
        >
          <img
            :src="coverUrl"
            :alt="`${session.room_name || session.room_url || '直播间'}封面`"
            class="h-full w-full object-cover transition-transform duration-300 group-hover/cover:scale-[1.03]"
            loading="lazy"
            decoding="async"
            @error="handleCoverError"
          />
        </a>
        <div
          v-else
          class="flex aspect-video flex-col items-center justify-center gap-1 self-start rounded-lg border border-dashed border-gray-300 bg-gray-50/60 text-gray-300"
          aria-label="暂无封面"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            class="h-5 w-5"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M2.25 15.75l5.159-5.159a2.25 2.25 0 012.561 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M18 12.75h.008v.008H18v-.008zM3.75 19.5h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5z"
            />
          </svg>
          <span class="text-[10px] leading-none">暂无封面</span>
        </div>

        <div class="min-w-0">
          <!-- 关键指标 -->
          <dl class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div
              v-for="item in metaItems"
              :key="item.label"
              class="min-w-0 rounded-lg border border-gray-200/70 bg-gray-50/60 px-2.5 py-2"
            >
              <dt class="text-[10px] font-medium uppercase tracking-wider text-gray-400">
                {{ item.label }}
              </dt>
              <dd class="mt-0.5 truncate text-sm font-medium tabular-nums text-gray-800">
                {{ item.value }}
              </dd>
            </div>
          </dl>

          <!-- 路径 / 直播流 / 投稿 -->
          <div class="mt-3 space-y-2 text-xs">
            <div class="flex items-baseline gap-2">
              <span class="w-14 shrink-0 text-gray-400">输出路径</span>
              <span class="min-w-0 break-all text-gray-600">{{ session.output_path || '-' }}</span>
            </div>
            <div class="flex items-baseline gap-2">
              <span class="w-14 shrink-0 text-gray-400">直播流</span>
              <code
                class="min-w-0 cursor-pointer break-all transition-colors hover:brightness-110"
                :title="session.stream_url || ''"
                @click="copyStreamUrl"
                >{{ truncatedStreamUrl || '-' }}</code
              >
            </div>
            <div v-if="uploadRecords.length > 0" class="flex items-baseline gap-2">
              <span class="w-14 shrink-0 text-gray-400">投稿</span>
              <div class="flex flex-wrap items-center gap-1">
                <span
                  v-for="u in uploadRecords"
                  :key="u.id"
                  class="rounded-full border px-2 py-0.5 text-[11px] font-medium"
                  :class="uploadPill(u.status)"
                  :title="u.status"
                >
                  {{ u.bv_id ? 'BV ' + u.bv_id : u.status }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 右栏：弹幕采集 -->
      <div class="flex flex-col rounded-xl border border-gray-200/70 bg-gray-50/50 p-3.5">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 text-gray-400">
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
                d="M8.25 6.75h7.5M8.25 11.25h4.5m-9 8.25h9a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3h-9a3 3 0 0 0-3 3v13.5Z"
              />
            </svg>
            <span class="text-[11px] font-medium uppercase tracking-wider">弹幕采集</span>
          </div>
          <span
            class="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
            :class="danmakuBadge.pill"
            :title="session.danmaku_error || ''"
          >
            {{ danmakuBadge.text }}
          </span>
        </div>

        <div class="mt-3 flex items-baseline gap-1.5">
          <span class="text-2xl font-semibold tabular-nums text-gray-900">{{
            session.danmaku_event_count || 0
          }}</span>
          <span class="text-xs text-gray-400">条事件</span>
          <span
            v-if="session.danmaku_error"
            class="ml-auto text-[11px] font-medium text-red-500"
            :title="session.danmaku_error"
            >采集异常</span
          >
        </div>

        <div class="mt-auto flex flex-wrap items-center gap-1.5 pt-3.5">
          <router-link
            :to="`/sessions/${session.id}/danmaku`"
            :class="[btnGhost, 'no-underline hover:bg-gray-50 hover:text-gray-900']"
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
                d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
              />
            </svg>
            弹幕详情
          </router-link>
          <button
            :class="[
              btnGhost,
              filesExpanded
                ? 'border-brand-200 bg-brand-50 text-brand-600'
                : 'hover:bg-gray-50 hover:text-gray-900',
            ]"
            @click="filesExpanded = !filesExpanded"
          >
            <svg
              class="h-3.5 w-3.5 transition-transform"
              :class="filesExpanded ? 'rotate-180' : ''"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
            文件
          </button>
          <a
            :href="logFileUrl"
            target="_blank"
            :class="[btnGhost, 'no-underline hover:bg-gray-50 hover:text-gray-900']"
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
                d="M8.25 6.75h7.5M8.25 12h7.5m-7.5 5.25h4.5M19.5 12a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z"
              />
            </svg>
            日志
          </a>
        </div>
      </div>
    </div>

    <!-- 分片文件面板（懒加载） -->
    <FilePanel v-if="filesExpanded" :session-id="session.id" />
  </article>
</template>
