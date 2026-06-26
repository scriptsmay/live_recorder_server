<script setup lang="ts">
/**
 * 转码 - 查看转码队列与历史
 * 从 transcode.ejs 迁移
 */
import { ref, computed, onMounted } from 'vue'
import { apiGet, apiDelete, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'
import Pagination from '@/components/Pagination.vue'

const toast = useToast()
const { confirm } = useConfirm()

interface TranscodeRow {
  id: number
  original_path: string
  transcoded_path: string
  status: string
  error: string | null
  room_name: string
  room_id: number
  session_id: number
  enqueued_at: string
  completed_at: string | null
}

const records = ref<TranscodeRow[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(true)

function fileName(fp: string | null) {
  if (!fp) return '-'
  return fp.split('/').pop() || '-'
}

// Stats
const transcodeActive = computed(
  () => records.value.filter((r) => r.status === 'processing' || r.status === 'queued').length,
)
const queuedCount = computed(() => records.value.filter((r) => r.status === 'queued').length)
const completedCount = computed(() => records.value.filter((r) => r.status === 'completed').length)
const failedCount = computed(() => records.value.filter((r) => r.status === 'failed').length)

// Active tasks
const activeTranscodes = computed(() =>
  records.value.filter((r) => r.status === 'processing' || r.status === 'queued'),
)

// History (non-active)
const historyTranscodes = computed(() =>
  records.value.filter((r) => r.status !== 'queued' && r.status !== 'processing'),
)

const hasHistory = computed(() => historyTranscodes.value.length > 0)

function historyStatusStyle(status: string) {
  if (status === 'completed') return 'text-green-700 bg-green-50'
  if (status === 'failed') return 'text-red-700 bg-red-50'
  return 'text-gray-500 bg-gray-50'
}

function historyStatusLabel(status: string) {
  return { completed: '完成', failed: '失败', skipped: '跳过' }[status] || status
}

async function loadData() {
  loading.value = true
  try {
    const tcRes = await apiGet<{ rows: TranscodeRow[]; total: number } | TranscodeRow[]>(
      `/api/transcode_records?limit=100&page=${page.value}`,
    )
    const tcData = tcRes.data
    records.value = Array.isArray(tcData) ? tcData : (tcData.rows ?? [])
    total.value = Array.isArray(tcData) ? tcData.length : (tcData.total ?? records.value.length)
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

async function deleteTranscode(id: number) {
  const ok = await confirm('确定删除此转码记录吗？')
  if (!ok) return
  try {
    await apiDelete(`/api/transcode_records/${id}`)
    toast.success('已删除')
    loadData()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '删除失败')
  }
}

onMounted(loadData)
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-gray-900">转码</h1>
      <p class="text-sm text-gray-500 mt-1">视频转码任务队列</p>
    </div>

    <!-- Overview stats bar -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      <div class="bg-white rounded-xl border border-gray-200 p-4 text-center shadow-sm">
        <div class="text-2xl font-bold text-amber-600">{{ transcodeActive }}</div>
        <div class="text-xs text-gray-500 mt-1">转码中</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 text-center shadow-sm">
        <div class="text-2xl font-bold text-purple-600">{{ queuedCount }}</div>
        <div class="text-xs text-gray-500 mt-1">排队</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 text-center shadow-sm">
        <div class="text-2xl font-bold text-green-600">{{ completedCount }}</div>
        <div class="text-xs text-gray-500 mt-1">已完成</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 text-center shadow-sm">
        <div class="text-2xl font-bold text-red-600">{{ failedCount }}</div>
        <div class="text-xs text-gray-500 mt-1">失败</div>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center py-12">
      <div
        class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"
      />
      <span class="text-sm text-gray-500">加载中...</span>
    </div>

    <template v-else>
      <!-- Active tasks section -->
      <div v-if="activeTranscodes.length > 0" class="mb-6">
        <h2 class="text-base font-semibold text-gray-800 mb-3 flex items-center gap-2">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
            <path
              fill-rule="evenodd"
              d="M10.804 8 5.494 2.69A1 1 0 0 0 4.08 3.478l5.31 5.31-5.31 5.309a1 1 0 0 0 1.414 1.485L10.804 9l5.31 5.309a1 1 0 0 0 1.414-1.485z"
            />
          </svg>
          活跃任务
        </h2>

        <div class="space-y-3">
          <!-- Transcode active cards -->
          <div
            v-for="r in activeTranscodes"
            :key="'tc-' + r.id"
            class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex"
          >
            <div class="w-1 bg-amber-500 shrink-0" />
            <div class="flex-1 p-4 flex items-start justify-between gap-4">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap mb-1">
                  <span class="px-2 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-700"
                    >转码</span
                  >
                  <span
                    class="px-2 py-0.5 text-xs font-medium rounded"
                    :class="
                      r.status === 'processing'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-yellow-100 text-yellow-700'
                    "
                  >
                    {{ r.status === 'processing' ? '转码中' : '排队中' }}
                  </span>
                  <span class="text-xs text-gray-400 font-mono">#{{ r.id }}</span>
                </div>
                <div class="text-sm">
                  <strong class="text-gray-900">{{ r.room_name || '未知直播间' }}</strong>
                  <span class="text-gray-400 ml-2 text-xs">会话 #{{ r.session_id || '-' }}</span>
                </div>
                <div class="flex items-center gap-2 mt-1 text-xs text-gray-500">
                  <code class="truncate max-w-[180px]" :title="r.original_path">{{
                    fileName(r.original_path)
                  }}</code>
                  <span class="text-gray-300">→</span>
                  <code class="truncate max-w-[180px]" :title="r.transcoded_path">{{
                    fileName(r.transcoded_path)
                  }}</code>
                </div>
                <p v-if="r.error" class="text-xs text-red-500 mt-1 truncate">{{ r.error }}</p>
              </div>
              <div class="flex flex-col gap-1.5 shrink-0">
                <button
                  class="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 transition-colors"
                  @click="deleteTranscode(r.id)"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- No active tasks -->
      <div v-else class="bg-white rounded-xl border border-gray-200 p-8 text-center shadow-sm mb-6">
        <p class="text-sm text-gray-400">暂无进行中的任务</p>
      </div>

      <!-- History section -->
      <div>
        <h2 class="text-base font-semibold text-gray-800 mb-3 flex items-center gap-2">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
            <path
              d="M0 2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2zm15 2h-4v3h4V4zm0 4h-4v3h4V8zm0 4h-4v3h4v-3zM1 2v12h4V2H1zm5 4h4V4H6v4zm4 4H6v3h4V8z"
            />
          </svg>
          历史记录
        </h2>

        <!-- History table -->
        <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th class="px-4 py-3 text-left font-medium text-gray-500 w-16">ID</th>
                  <th class="px-4 py-3 text-left font-medium text-gray-500">会话 / 直播间</th>
                  <th class="px-4 py-3 text-left font-medium text-gray-500">原文件</th>
                  <th class="px-4 py-3 text-left font-medium text-gray-500">输出文件</th>
                  <th class="px-4 py-3 text-left font-medium text-gray-500 w-20">状态</th>
                  <th class="px-4 py-3 text-left font-medium text-gray-500 w-36">入队时间</th>
                  <th class="px-4 py-3 text-left font-medium text-gray-500 w-36">完成时间</th>
                  <th class="px-4 py-3 text-right font-medium text-gray-500 w-24">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100">
                <tr v-if="!hasHistory">
                  <td colspan="8" class="px-4 py-12 text-center text-gray-400">暂无历史记录</td>
                </tr>

                <!-- Transcode rows -->
                <tr
                  v-for="r in historyTranscodes"
                  :key="'htc-' + r.id"
                  class="hover:bg-gray-50 transition-colors"
                >
                  <td class="px-4 py-3 font-mono text-xs text-gray-400">#{{ r.id }}</td>
                  <td class="px-4 py-3">
                    <div v-if="r.room_name" class="text-sm text-gray-700">{{ r.room_name }}</div>
                    <span class="text-xs text-gray-400">会话 {{ r.session_id || '-' }}</span>
                  </td>
                  <td
                    class="px-4 py-3 text-xs text-gray-500 break-all max-w-[180px]"
                    :title="r.original_path"
                  >
                    {{ fileName(r.original_path) }}
                  </td>
                  <td
                    class="px-4 py-3 text-xs text-gray-500 break-all max-w-[180px]"
                    :title="r.transcoded_path"
                  >
                    {{ fileName(r.transcoded_path) }}
                  </td>
                  <td class="px-4 py-3">
                    <span
                      class="px-2 py-0.5 text-xs font-medium rounded"
                      :class="historyStatusStyle(r.status)"
                    >
                      {{ historyStatusLabel(r.status) }}
                    </span>
                    <div v-if="r.error" class="text-xs text-red-400 mt-0.5 truncate max-w-[100px]">
                      {{ r.error }}
                    </div>
                  </td>
                  <td class="px-4 py-3 text-xs text-gray-500">{{ $formatTime(r.enqueued_at) }}</td>
                  <td class="px-4 py-3 text-xs text-gray-500">{{ $formatTime(r.completed_at) }}</td>
                  <td class="px-4 py-3 text-right">
                    <button
                      class="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 transition-colors"
                      @click="deleteTranscode(r.id)"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="px-4 pb-4">
            <Pagination
              :current="page"
              :total="total"
              :page-size="100"
              @change="handlePageChange"
            />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
