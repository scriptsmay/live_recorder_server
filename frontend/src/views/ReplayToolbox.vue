<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useReplayToolboxStore } from '@/stores/replay-toolbox'
import { useConfirm } from '@/utils/confirm'
import { useToast } from '@/utils/toast'
import { formatTime } from '@/utils/lib'
import type { ReplayRecordStatus, ReplaySettings } from '@/types/api'

const store = useReplayToolboxStore()
const { confirm } = useConfirm()
const toast = useToast()

const statusFilter = ref('all')
const syncCount = ref(1)
const enqueueCount = ref(1)
const settingsDraft = ref<ReplaySettings>({
  upload_template_id: '',
  auto_upload: 'false',
  auto_backup: 'true',
  max_count_per_run: '1',
})
let pollTimer: ReturnType<typeof setInterval> | null = null

const statusOptions = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待处理' },
  { value: 'extracted', label: '已提取' },
  { value: 'downloaded', label: '已下载' },
  { value: 'cut', label: '已剪切' },
  { value: 'fixed', label: '已修复' },
  { value: 'uploaded', label: '已投稿' },
  { value: 'failed', label: '失败' },
]

const statusLabels: Record<string, string> = {
  pending: '待处理',
  extracted: '已提取',
  downloaded: '已下载',
  cut: '已剪切',
  fixed: '已修复',
  uploaded: '已投稿',
  backed_up: '已备份',
  failed: '失败',
}

const statusClasses: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  extracted: 'bg-sky-100 text-sky-700',
  downloaded: 'bg-indigo-100 text-indigo-700',
  cut: 'bg-violet-100 text-violet-700',
  fixed: 'bg-emerald-100 text-emerald-700',
  uploaded: 'bg-green-100 text-green-700',
  backed_up: 'bg-teal-100 text-teal-700',
  failed: 'bg-red-100 text-red-700',
}

const totalPages = computed(() => Math.max(1, Math.ceil(store.total / store.pageSize)))

const hasPrincipal = computed(() => Boolean(store.selectedPrincipalId))

watch(
  () => store.settings,
  (settings) => {
    if (!settings) return
    settingsDraft.value = { ...settings }
  },
  { immediate: true },
)

onMounted(async () => {
  await store.fetchPrincipals()
  if (store.selectedPrincipalId) {
    await Promise.all([
      store.fetchRecords({ status: statusFilter.value, page: 1 }),
      store.fetchUploads(),
      store.fetchSettings(),
    ])
  }
  await store.fetchTaskStatus()
  pollTimer = setInterval(() => store.fetchTaskStatus(), 15000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function displayTime(value: string | null | undefined) {
  return value ? formatTime(value) : '-'
}

function displayDuration(seconds: number | null | undefined) {
  if (!seconds) return '-'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
  }
  return `${minutes}m ${rest}s`
}

function displaySize(bytes: number | null | undefined) {
  if (!bytes) return '-'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function statusLabel(status: ReplayRecordStatus | string | null) {
  return statusLabels[status || 'pending'] ?? status ?? '-'
}

function statusClass(status: ReplayRecordStatus | string | null) {
  return statusClasses[status || 'pending'] ?? 'bg-gray-100 text-gray-700'
}

async function handleSelectPrincipal(principalId: string) {
  await store.selectPrincipal(principalId, statusFilter.value)
}

async function handleFilterChange(value: string) {
  statusFilter.value = value
  await store.fetchRecords({ status: value, page: 1 })
}

async function handleRefresh() {
  await Promise.all([
    store.fetchPrincipals(),
    store.fetchRecords({ status: statusFilter.value }),
    store.fetchUploads(),
    store.fetchTaskStatus(),
  ])
  toast.info('已刷新')
}

async function handleSync(dryRun = false) {
  if (!hasPrincipal.value) return
  const ok = dryRun || (await confirm(`同步最近 ${syncCount.value} 条回放记录？`))
  if (!ok) return
  await store.syncRecords(syncCount.value, dryRun)
}

async function handleEnqueuePrincipal(dryRun = false) {
  if (!hasPrincipal.value) return
  const ok = dryRun || (await confirm(`将最近 ${enqueueCount.value} 条未完成回放加入处理队列？`))
  if (!ok) return
  await store.enqueuePrincipal(enqueueCount.value, dryRun)
}

async function handleAction(recordId: number, action: string) {
  const ok = await confirm(`确认执行 ${action} 任务？`, { title: `回放 #${recordId}` })
  if (!ok) return
  await store.enqueueRecord(recordId, action)
}

async function handleSaveSettings() {
  await store.updateSettings(settingsDraft.value)
}

async function handlePage(delta: number) {
  const next = Math.min(totalPages.value, Math.max(1, store.page + delta))
  if (next === store.page) return
  await store.fetchRecords({ status: statusFilter.value, page: next })
}
</script>

<template>
  <div>
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">回放工具箱</h1>
        <p class="text-sm text-gray-500 mt-1">快手回放拉取、处理队列、投稿与备份管理</p>
      </div>
      <button
        class="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
        @click="handleRefresh"
      >
        刷新
      </button>
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
      <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div class="text-xs text-gray-500">主播数</div>
        <div class="text-2xl font-semibold text-gray-900 mt-1">{{ store.principals.length }}</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div class="text-xs text-gray-500">当前记录</div>
        <div class="text-2xl font-semibold text-gray-900 mt-1">{{ store.total }}</div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div class="text-xs text-gray-500">队列等待</div>
        <div class="text-2xl font-semibold text-gray-900 mt-1">
          {{ store.taskStatus?.queue_length ?? 0 }}
        </div>
      </div>
      <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <div class="text-xs text-gray-500">处理中 / 并发</div>
        <div class="text-2xl font-semibold text-gray-900 mt-1">
          {{ store.taskStatus?.processing ?? 0 }} / {{ store.taskStatus?.concurrency ?? 1 }}
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 xl:grid-cols-[300px_1fr] gap-4">
      <aside class="space-y-4">
        <div class="bg-white rounded-xl border border-gray-200 shadow-sm">
          <div class="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-gray-900">快手主播</h2>
            <span class="text-xs text-gray-400">{{
              store.loadingPrincipals ? '加载中' : '自动识别'
            }}</span>
          </div>
          <div class="max-h-[520px] overflow-y-auto p-2">
            <button
              v-for="principal in store.principals"
              :key="principal.principal_id"
              class="w-full text-left px-3 py-3 rounded-lg transition-colors mb-1"
              :class="
                store.selectedPrincipalId === principal.principal_id
                  ? 'bg-brand-50 text-brand-700'
                  : 'hover:bg-gray-50 text-gray-700'
              "
              @click="handleSelectPrincipal(principal.principal_id)"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="text-sm font-medium truncate">{{ principal.room_name }}</span>
                <span class="text-xs text-gray-400 shrink-0">{{ principal.replay_count }}</span>
              </div>
              <div class="text-xs text-gray-400 truncate mt-1">{{ principal.principal_id }}</div>
              <div class="text-xs text-gray-400 mt-1">
                {{ displayTime(principal.latest_replay_time) }}
              </div>
            </button>
            <div
              v-if="!store.loadingPrincipals && store.principals.length === 0"
              class="p-6 text-center text-sm text-gray-400"
            >
              暂无快手直播间
            </div>
          </div>
        </div>

        <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <h2 class="text-sm font-semibold text-gray-900 mb-3">主播配置</h2>
          <div class="space-y-3">
            <label class="block">
              <span class="text-xs text-gray-500">投稿模板 ID</span>
              <input
                v-model="settingsDraft.upload_template_id"
                type="text"
                class="mt-1 w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
                :disabled="!hasPrincipal"
              />
            </label>
            <label class="block">
              <span class="text-xs text-gray-500">单次最大处理数</span>
              <input
                v-model="settingsDraft.max_count_per_run"
                type="number"
                min="1"
                class="mt-1 w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
                :disabled="!hasPrincipal"
              />
            </label>
            <label class="flex items-center justify-between text-sm text-gray-700">
              <span>自动投稿</span>
              <input
                v-model="settingsDraft.auto_upload"
                true-value="true"
                false-value="false"
                type="checkbox"
                class="w-4 h-4 accent-brand-600"
                :disabled="!hasPrincipal"
              />
            </label>
            <label class="flex items-center justify-between text-sm text-gray-700">
              <span>投稿后备份</span>
              <input
                v-model="settingsDraft.auto_backup"
                true-value="true"
                false-value="false"
                type="checkbox"
                class="w-4 h-4 accent-brand-600"
                :disabled="!hasPrincipal"
              />
            </label>
            <button
              class="w-full px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              :disabled="!hasPrincipal || store.busy"
              @click="handleSaveSettings"
            >
              保存配置
            </button>
          </div>
        </div>
      </aside>

      <main class="space-y-4 min-w-0">
        <div class="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div class="flex flex-wrap items-center gap-3">
            <div class="flex items-center gap-2">
              <span class="text-sm text-gray-500 shrink-0">状态：</span>
              <button
                v-for="option in statusOptions"
                :key="option.value"
                class="px-3 py-1 text-xs font-medium rounded-full transition-colors"
                :class="
                  statusFilter === option.value
                    ? 'bg-brand-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                "
                @click="handleFilterChange(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
            <div class="flex items-center gap-2 ml-auto">
              <input
                v-model.number="syncCount"
                type="number"
                min="1"
                max="20"
                class="w-20 px-2 py-1.5 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-brand-500"
                :disabled="!hasPrincipal"
              />
              <button
                class="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                :disabled="!hasPrincipal || store.busy"
                @click="handleSync(true)"
              >
                dry-run
              </button>
              <button
                class="px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
                :disabled="!hasPrincipal || store.busy"
                @click="handleSync(false)"
              >
                同步回放
              </button>
            </div>
          </div>
        </div>

        <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
            <h2 class="text-sm font-semibold text-gray-900">回放记录</h2>
            <div class="ml-auto flex items-center gap-2">
              <input
                v-model.number="enqueueCount"
                type="number"
                min="1"
                max="20"
                class="w-20 px-2 py-1.5 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-brand-500"
                :disabled="!hasPrincipal"
              />
              <button
                class="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                :disabled="!hasPrincipal || store.busy"
                @click="handleEnqueuePrincipal(true)"
              >
                预览批量
              </button>
              <button
                class="px-3 py-1.5 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                :disabled="!hasPrincipal || store.busy"
                @click="handleEnqueuePrincipal(false)"
              >
                批量全流程
              </button>
            </div>
          </div>

          <div class="overflow-x-auto">
            <table class="min-w-full divide-y divide-gray-100">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">时间</th>
                  <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">回放</th>
                  <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">状态</th>
                  <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">时长</th>
                  <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">大小</th>
                  <th class="px-4 py-2 text-right text-xs font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 bg-white">
                <tr v-if="store.loadingRecords">
                  <td colspan="6" class="px-4 py-10 text-center text-sm text-gray-400">
                    加载中...
                  </td>
                </tr>
                <tr v-else-if="store.records.length === 0">
                  <td colspan="6" class="px-4 py-10 text-center text-sm text-gray-400">
                    暂无回放记录
                  </td>
                </tr>
                <tr
                  v-for="record in store.records"
                  v-else
                  :key="record.id"
                  class="hover:bg-gray-50"
                >
                  <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                    {{ displayTime(record.start_time) }}
                  </td>
                  <td class="px-4 py-3">
                    <div class="text-sm font-medium text-gray-900 truncate max-w-[260px]">
                      {{ record.video_file_name || record.replay_id || `#${record.id}` }}
                    </div>
                    <div class="text-xs text-gray-400 truncate max-w-[260px]">
                      {{ record.play_url || record.m3u8_url || '-' }}
                    </div>
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap">
                    <span
                      class="inline-flex px-2 py-0.5 text-xs font-medium rounded-full"
                      :class="statusClass(record.status)"
                    >
                      {{ statusLabel(record.status) }}
                    </span>
                    <div
                      v-if="record.error_message"
                      class="text-xs text-red-500 mt-1 max-w-[220px] truncate"
                    >
                      {{ record.error_message }}
                    </div>
                  </td>
                  <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                    {{ displayDuration(record.duration) }}
                  </td>
                  <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                    {{ displaySize(record.file_size) }}
                  </td>
                  <td class="px-4 py-3 text-right">
                    <div class="inline-flex flex-wrap justify-end gap-1.5">
                      <button
                        class="px-2 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                        @click="handleAction(record.id, 'extract')"
                      >
                        提取
                      </button>
                      <button
                        class="px-2 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                        @click="handleAction(record.id, 'download')"
                      >
                        下载
                      </button>
                      <button
                        class="px-2 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                        @click="handleAction(record.id, 'cut')"
                      >
                        剪切
                      </button>
                      <button
                        class="px-2 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                        @click="handleAction(record.id, 'fix')"
                      >
                        修复
                      </button>
                      <button
                        class="px-2 py-1 text-xs rounded bg-brand-600 text-white hover:bg-brand-700"
                        @click="handleAction(record.id, 'all')"
                      >
                        全流程
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div
            class="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-sm text-gray-500"
          >
            <span>第 {{ store.page }} / {{ totalPages }} 页，共 {{ store.total }} 条</span>
            <div class="flex items-center gap-2">
              <button
                class="px-3 py-1 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                :disabled="store.page <= 1"
                @click="handlePage(-1)"
              >
                上一页
              </button>
              <button
                class="px-3 py-1 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                :disabled="store.page >= totalPages"
                @click="handlePage(1)"
              >
                下一页
              </button>
            </div>
          </div>
        </div>

        <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-100">
            <h2 class="text-sm font-semibold text-gray-900">最近投稿</h2>
          </div>
          <div class="overflow-x-auto">
            <table class="min-w-full divide-y divide-gray-100">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">时间</th>
                  <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">标题</th>
                  <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">状态</th>
                  <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">BV</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100">
                <tr v-if="store.uploads.length === 0">
                  <td colspan="4" class="px-4 py-8 text-center text-sm text-gray-400">
                    暂无投稿记录
                  </td>
                </tr>
                <tr v-for="upload in store.uploads" v-else :key="upload.id">
                  <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                    {{ displayTime(upload.created_at) }}
                  </td>
                  <td class="px-4 py-3 text-sm text-gray-900 max-w-[420px] truncate">
                    {{ upload.title || `回放 #${upload.replay_record_id}` }}
                  </td>
                  <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                    {{ upload.status }}
                  </td>
                  <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                    {{ upload.bv_id || '-' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>
