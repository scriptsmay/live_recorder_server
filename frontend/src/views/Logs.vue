<script setup lang="ts">
/**
 * 日志查看器 - 实时日志流
 *
 * 从 logs.ejs 迁移
 * - 两栏布局：左侧文件列表，右侧日志查看器
 * - SSE (EventSource) 实时日志流
 * - 自动滚动、自动截断（超过 5000 行保留最后 4000 行）
 * - 删除日志文件
 *
 * 注意：日志文件列表需要后端提供 GET /api/logs/files 端点
 * 返回格式: { status: 'ok', data: string[] }
 * 实现: router/logs.js 中添加 logFiles.listFiles() 调用即可
 */
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiGet, apiDelete, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'

const toast = useToast()
const { confirm } = useConfirm()
const route = useRoute()
const router = useRouter()

// ---- 状态 ----
const logFiles = ref<string[]>([])
const selectedFile = ref('')
const logLines = ref<string[]>([])
const loadingFileList = ref(false)
const loadingContent = ref(false)
const liveEnabled = ref(false)
const autoScroll = ref(true)
const statusText = ref('')
const fileSizeText = ref('-')

// ---- 常量 ----
const MAX_LINES = 5000
const KEEP_LINES = 4000

// ---- DOM 引用 ----
const logPanelRef = ref<HTMLElement | null>(null)

// ---- SSE ----
let eventSource: EventSource | null = null

// ---- 工具函数 ----
function formatBytes(bytes: number) {
  if (!bytes) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let val = bytes
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return val.toFixed(1) + ' ' + units[i]
}

function scrollToBottom() {
  if (autoScroll.value && logPanelRef.value) {
    logPanelRef.value.scrollTop = logPanelRef.value.scrollHeight
  }
}

// 监听行数变化，自动滚动到底部
watch(
  () => logLines.value.length,
  () => {
    nextTick(scrollToBottom)
  },
)

// ---- 加载文件列表 ----
async function fetchFileList() {
  loadingFileList.value = true
  try {
    const res = await apiGet<string[]>('/api/logs/files')
    logFiles.value = Array.isArray(res.data) ? res.data : []
    // 优先使用 URL query 参数指定的文件，其次默认选中第一个
    const queryFile = (route.query.file as string) || ''
    if (queryFile && logFiles.value.includes(queryFile)) {
      await selectFile(queryFile, { updateQuery: false })
    } else if (logFiles.value.length > 0 && !selectedFile.value) {
      await selectFile(logFiles.value[0])
    }
  } catch {
    toast.error('加载日志文件列表失败')
    logFiles.value = []
  } finally {
    loadingFileList.value = false
  }
}

// ---- 选中文件并加载内容 ----
async function selectFile(file: string, options: { updateQuery?: boolean } = {}) {
  const { updateQuery = true } = options
  if (!file || file === selectedFile.value) return

  // 关闭旧的 SSE 连接
  closeStream()
  liveEnabled.value = false
  selectedFile.value = file
  logLines.value = []
  fileSizeText.value = '-'
  statusText.value = ''
  loadingContent.value = true

  if (updateQuery && route.query.file !== file) {
    await router.replace({
      query: {
        ...route.query,
        file,
      },
    })
  }

  try {
    const res = await apiGet<{
      file: string
      lines: string[]
      truncated: boolean
      offset?: number
    }>(`/api/logs/content?file=${encodeURIComponent(file)}&tail=${MAX_LINES}`)

    logLines.value = res.data.lines || []

    if (res.data.offset) {
      fileSizeText.value = formatBytes(res.data.offset)
    }

    statusText.value = res.data.truncated
      ? '仅显示文件尾部内容（完整内容请下载查看）'
      : '已加载完整内容'
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '加载日志内容失败')
    statusText.value = '加载失败'
  } finally {
    loadingContent.value = false
  }
}

// ---- SSE 实时流 ----
function openStream() {
  closeStream()

  const url = `/api/logs/stream?file=${encodeURIComponent(selectedFile.value)}&tail=0`
  eventSource = new EventSource(url)
  statusText.value = '实时查看已开启，新内容将自动追加'

  eventSource.addEventListener('log', (event: MessageEvent) => {
    const data = JSON.parse(event.data)
    appendLine(data.line)
  })

  eventSource.addEventListener('reset', () => {
    logLines.value = []
    statusText.value = '日志文件已轮转，已重新接入'
  })

  eventSource.addEventListener('log-error', (event: MessageEvent) => {
    const data = JSON.parse(event.data)
    statusText.value = '错误: ' + (data.message || '日志读取失败')
  })

  eventSource.addEventListener('ready', (event: MessageEvent) => {
    const data = JSON.parse(event.data)
    if (data.truncated) {
      statusText.value = '实时查看已开启，仅显示新增内容'
    }
    if (data.offset) {
      fileSizeText.value = formatBytes(data.offset)
    }
  })

  eventSource.addEventListener('error', () => {
    statusText.value = '实时连接中断，浏览器将自动重连...'
  })
}

function closeStream() {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
}

function appendLine(line: string) {
  logLines.value.push(line)
  // 超过上限时截断，保留最后 KEEP_LINES 行
  if (logLines.value.length > MAX_LINES) {
    logLines.value = logLines.value.slice(-KEEP_LINES)
    statusText.value = '内容过长，已自动截断旧日志'
  }
}

function toggleLive() {
  if (liveEnabled.value) {
    openStream()
  } else {
    closeStream()
    statusText.value = '实时查看已关闭'
  }
}

function handleToggleLive() {
  liveEnabled.value = !liveEnabled.value
  toggleLive()
}

function handleToggleAutoScroll() {
  autoScroll.value = !autoScroll.value
  if (autoScroll.value) scrollToBottom()
}

// ---- 删除日志文件 ----
async function handleDelete() {
  if (!selectedFile.value) return
  const ok = await confirm(`确定要删除 ${selectedFile.value} 吗？此操作不可恢复。`)
  if (!ok) return

  try {
    await apiDelete('/api/logs', { file: selectedFile.value })
    toast.success('日志文件已删除')
    closeStream()
    liveEnabled.value = false
    selectedFile.value = ''
    logLines.value = []
    statusText.value = ''
    fileSizeText.value = '-'
    const query = { ...route.query }
    delete query.file
    await router.replace({ query })
    await fetchFileList()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '删除失败')
  }
}

// ---- 生命周期 ----
watch(
  () => route.query.file,
  (file) => {
    const nextFile = typeof file === 'string' ? file : ''
    if (!nextFile || nextFile === selectedFile.value) return
    if (logFiles.value.includes(nextFile)) {
      selectFile(nextFile, { updateQuery: false })
    }
  },
)

onMounted(fetchFileList)

onUnmounted(() => {
  closeStream()
})
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-gray-900 mb-6">日志查看</h1>

    <div class="flex flex-col md:flex-row gap-4">
      <!-- 左侧：文件列表 -->
      <div class="md:w-64 lg:w-72 shrink-0">
        <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-200 bg-gray-50">
            <h2 class="text-sm font-semibold text-gray-700">日志文件</h2>
          </div>
          <div class="max-h-[70vh] overflow-y-auto">
            <!-- 加载中 -->
            <div v-if="loadingFileList" class="px-4 py-6 text-center">
              <div
                class="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-2"
              />
              <span class="text-xs text-gray-400">加载中...</span>
            </div>

            <!-- 空状态 -->
            <div
              v-else-if="logFiles.length === 0"
              class="px-4 py-6 text-center text-sm text-gray-400"
            >
              暂无日志文件
            </div>

            <!-- 文件列表 -->
            <button
              v-for="file in logFiles"
              :key="file"
              class="w-full text-left px-4 py-2.5 text-sm border-b border-gray-100 last:border-b-0 transition-colors truncate"
              :class="
                selectedFile === file
                  ? 'bg-brand-50 text-brand-700 font-medium border-l-2 border-l-brand-500'
                  : 'text-gray-700 hover:bg-gray-50'
              "
              :title="file"
              @click="selectFile(file)"
            >
              {{ file }}
            </button>
          </div>
        </div>
      </div>

      <!-- 右侧：日志查看器 -->
      <div class="flex-1 min-w-0">
        <!-- 未选中文件 -->
        <div
          v-if="!selectedFile"
          class="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center"
        >
          <p class="text-sm text-gray-400">请从左侧列表选择要查看的日志文件</p>
          <p class="text-xs text-gray-300 mt-2">
            日志文件保存在 <code class="bg-gray-100 px-1 rounded">logs/</code> 目录
          </p>
        </div>

        <!-- 日志查看器 -->
        <div v-else class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <!-- 头部工具栏 -->
          <div
            class="px-4 py-3 border-b border-gray-200 bg-gray-50 flex flex-wrap items-center justify-between gap-3"
          >
            <div class="flex items-center gap-3 min-w-0">
              <h3 class="text-sm font-semibold text-gray-900 truncate">{{ selectedFile }}</h3>
              <span
                class="shrink-0 inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-gray-200 text-gray-600"
              >
                {{ fileSizeText }}
              </span>
            </div>

            <div class="flex items-center gap-4 shrink-0">
              <!-- 实时查看开关 -->
              <label class="flex items-center gap-2 cursor-pointer">
                <button
                  role="switch"
                  :aria-checked="liveEnabled"
                  class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
                  :class="liveEnabled ? 'bg-brand-600' : 'bg-gray-300'"
                  @click="handleToggleLive"
                >
                  <span
                    class="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform"
                    :class="liveEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'"
                  />
                </button>
                <span class="text-xs text-gray-600">实时查看</span>
              </label>

              <!-- 自动滚动开关 -->
              <label class="flex items-center gap-2 cursor-pointer">
                <button
                  role="switch"
                  :aria-checked="autoScroll"
                  class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
                  :class="autoScroll ? 'bg-brand-600' : 'bg-gray-300'"
                  @click="handleToggleAutoScroll"
                >
                  <span
                    class="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform"
                    :class="autoScroll ? 'translate-x-[18px]' : 'translate-x-0.5'"
                  />
                </button>
                <span class="text-xs text-gray-600">自动滚动</span>
              </label>

              <!-- 删除按钮 -->
              <button
                class="px-2.5 py-1 text-xs font-medium rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                @click="handleDelete"
              >
                删除
              </button>
            </div>
          </div>

          <!-- 状态栏 -->
          <div class="px-4 py-2 border-b border-gray-100 bg-gray-50/50">
            <span class="text-xs text-gray-500">{{ statusText || '就绪' }}</span>
          </div>

          <!-- 日志内容区域 -->
          <div ref="logPanelRef" class="overflow-auto" style="max-height: 60vh; min-height: 300px">
            <!-- 加载中 -->
            <div v-if="loadingContent" class="flex items-center justify-center py-12">
              <div
                class="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mr-3"
              />
              <span class="text-sm text-gray-500">加载日志内容...</span>
            </div>

            <!-- 空内容 -->
            <div
              v-else-if="logLines.length === 0"
              class="px-4 py-12 text-center text-sm text-gray-400"
            >
              日志文件为空
            </div>

            <!-- 日志行 -->
            <pre
              v-else
              class="mb-0 p-4 text-xs leading-relaxed text-gray-700 font-mono whitespace-pre"
            ><template v-for="(line, idx) in logLines" :key="idx">{{ line }}
</template></pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
