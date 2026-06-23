<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useFileStore } from '@/stores/file-manage'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'
import FileSummary from '@/components/Files/FileSummary.vue'
import FileTable from '@/components/Files/FileTable.vue'
import FileDetailDrawer from '@/components/Files/FileDetailDrawer.vue'
import CleanupRules from '@/components/Files/CleanupRules.vue'
import type { ManagedFile, DeleteTaskStatus } from '@/types/file-manage'

const fileStore = useFileStore()
const toast = useToast()
const { confirm } = useConfirm()

// ---- 筛选状态 ----
const activeTab = ref<string>('all')
const filterStatus = ref('')
const filterExt = ref('')
const filterSafeToDelete = ref('')
const selectedIds = ref<Set<number>>(new Set())
const detailFileId = ref<number | null>(null)
const detailVisible = ref(false)

const tabs = [
  { key: 'all', label: '全部文件' },
  { key: 'recording', label: '直播录制' },
  { key: 'replay', label: '回放文件' },
  { key: 'danmaku', label: '弹幕压制' },
  { key: 'orphan', label: '孤儿文件' },
  { key: 'cleanup', label: '清理规则' },
]

// ---- 批量删除流程 ----
const batchDialogVisible = ref(false)
const batchStep = ref<'plan' | 'confirm' | 'progress' | 'result'>('plan')
const batchTaskStatus = ref<DeleteTaskStatus | null>(null)

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i]
}

function buildFilters() {
  const filters: Record<string, unknown> = {}
  if (activeTab.value !== 'all') filters.category = activeTab.value
  if (filterStatus.value) filters.status = filterStatus.value
  if (filterExt.value) filters.ext = filterExt.value
  if (filterSafeToDelete.value) filters.safe_to_delete = filterSafeToDelete.value === 'true'
  return filters
}

async function loadFiles(page?: number) {
  if (page) fileStore.fileListPage = page
  await fileStore.fetchFileList(buildFilters())
}

async function handleRefresh() {
  selectedIds.value = new Set()
  await Promise.all([fileStore.fetchSummary(), loadFiles()])
}

function handleTabChange(tab: string) {
  activeTab.value = tab
  selectedIds.value = new Set()
  loadFiles(1)
}

function handleFilterChange() {
  selectedIds.value = new Set()
  loadFiles(1)
}

function handlePageChange(page: number) {
  loadFiles(page)
}

function handleRowClick(file: ManagedFile) {
  detailFileId.value = file.id
  detailVisible.value = true
}

function handleCloseDetail() {
  detailVisible.value = false
}

// ---- 单文件删除 ----
async function handleDeleteSingle(file: ManagedFile) {
  const ok = await confirm(
    `确定删除文件 "${file.file_name}" (${formatBytes(file.file_size || 0)})？\n路径: ${file.file_path}\n\n此操作不可撤销。`,
    { title: '删除文件', confirmText: '删除', cancelText: '取消' },
  )
  if (!ok) return

  const result = await fileStore.deleteSingleFile(file.id)
  if (result) {
    if (result.result === 'success' || result.result === 'success_noop') {
      toast.success(`文件已删除: ${file.file_name}`)
    } else if (result.result === 'blocked') {
      toast.warning(`删除被阻止: ${result.error}`)
    } else {
      toast.error(`删除失败: ${result.error}`)
    }
    detailVisible.value = false
    await handleRefresh()
  }
}

// ---- 批量删除 ----
async function openBatchDelete() {
  if (selectedIds.value.size === 0) {
    toast.warning('请先选择要删除的文件')
    return
  }

  batchStep.value = 'plan'
  batchDialogVisible.value = true
  fileStore.deletePlan = null

  const plan = await fileStore.generateDeletePlan({ file_ids: Array.from(selectedIds.value) })
  if (plan) {
    batchStep.value = 'confirm'
  } else {
    batchDialogVisible.value = false
  }
}

async function confirmBatchDelete() {
  if (!fileStore.deletePlan) return

  batchStep.value = 'progress'
  const taskId = await fileStore.executeDelete(fileStore.deletePlan.plan_id)
  if (!taskId) {
    batchDialogVisible.value = false
    return
  }

  fileStore.startPollingDeleteTask(taskId, (status) => {
    batchTaskStatus.value = status
    batchStep.value = 'result'
    handleRefresh()
  })

  // 也立即拉一次状态
  await fileStore.fetchDeleteTaskStatus(taskId)
}

function closeBatchDialog() {
  fileStore.stopPollingDeleteTask()
  batchDialogVisible.value = false
  selectedIds.value = new Set()
}

// ---- 扫描 ----
async function handleScan() {
  await fileStore.triggerScan()
}

// ---- 初始化 ----
onMounted(() => {
  handleRefresh()
})

onUnmounted(() => {
  fileStore.stopPollingDeleteTask()
})
</script>

<template>
  <div class="space-y-6">
    <!-- 页面标题 -->
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-gray-900">文件管理</h1>
      <div class="flex gap-2">
        <button
          class="px-3 py-2 text-sm rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
          :disabled="fileStore.scanLoading"
          @click="handleScan"
        >
          <svg v-if="fileStore.scanLoading" class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          扫描
        </button>
        <button
          class="px-3 py-2 text-sm rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
          @click="handleRefresh"
        >
          刷新
        </button>
      </div>
    </div>

    <!-- 空间概览 -->
    <FileSummary />

    <!-- 标签页 + 筛选 -->
    <section class="bg-white rounded-xl border border-gray-200 shadow-sm">
      <!-- 标签页 -->
      <div class="flex border-b border-gray-200 px-4">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="px-4 py-3 text-sm font-medium border-b-2 transition-colors"
          :class="
            activeTab === tab.key
              ? 'border-brand-600 text-brand-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          "
          @click="handleTabChange(tab.key)"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- 筛选条件栏（非清理规则标签页时显示） -->
      <div v-if="activeTab !== 'cleanup'" class="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-gray-100 bg-gray-50/50">
        <select
          v-model="filterStatus"
          class="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
          @change="handleFilterChange"
        >
          <option value="">全部状态</option>
          <option value="active">active</option>
          <option value="missing">missing</option>
          <option value="deleted">deleted</option>
        </select>

        <select
          v-model="filterExt"
          class="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
          @change="handleFilterChange"
        >
          <option value="">全部类型</option>
          <option value="ts">.ts</option>
          <option value="mp4">.mp4</option>
          <option value="mkv">.mkv</option>
          <option value="m3u8">.m3u8</option>
          <option value="jsonl">.jsonl</option>
          <option value="ass">.ass</option>
        </select>

        <select
          v-model="filterSafeToDelete"
          class="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
          @change="handleFilterChange"
        >
          <option value="">是否可删除</option>
          <option value="true">可安全删除</option>
          <option value="false">不可删除</option>
        </select>

        <div class="flex-1" />

        <button
          v-if="selectedIds.size > 0"
          class="px-3 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors"
          @click="openBatchDelete"
        >
          批量删除 ({{ selectedIds.size }})
        </button>
      </div>

      <!-- 文件表格（非清理规则标签页时显示） -->
      <div v-if="activeTab !== 'cleanup'">
        <FileTable
          :files="fileStore.fileList"
          :loading="fileStore.fileListLoading"
          :selected-ids="selectedIds"
          v-model:total="fileStore.fileListTotal"
          v-model:page="fileStore.fileListPage"
          v-model:limit="fileStore.fileListLimit"
          @update:selected-ids="selectedIds = $event"
          @row-click="handleRowClick"
          @delete-single="handleDeleteSingle"
          @page-change="handlePageChange"
        />
      </div>

      <!-- 清理规则（仅在清理规则标签页时显示） -->
      <div v-else class="p-4">
        <CleanupRules />
      </div>
    </section>

    <!-- 文件详情抽屉 -->
    <FileDetailDrawer
      :visible="detailVisible"
      :file-id="detailFileId"
      @close="handleCloseDetail"
      @delete-single="handleDeleteSingle"
    />

    <!-- 批量删除对话框 -->
    <Transition name="fade">
      <div v-if="batchDialogVisible" class="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto">
          <!-- 头部 -->
          <div class="px-6 py-4 border-b border-gray-200">
            <h2 class="text-lg font-bold text-gray-900">批量删除</h2>
          </div>

          <div class="px-6 py-4">
            <!-- Step: plan (dry-run 进行中) -->
            <div v-if="batchStep === 'plan'" class="text-center py-8">
              <svg class="animate-spin h-8 w-8 mx-auto mb-3 text-gray-400" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p class="text-gray-500">正在生成删除计划...</p>
            </div>

            <!-- Step: confirm (dry-run 结果) -->
            <div v-if="batchStep === 'confirm' && fileStore.deletePlan" class="space-y-4">
              <div class="bg-green-50 rounded-lg p-4">
                <div class="text-sm text-green-800">
                  <span class="font-bold">{{ fileStore.deletePlan.deletable_count }}</span> 个文件可删除，
                  预计释放 <span class="font-bold">{{ formatBytes(fileStore.deletePlan.total_size) }}</span>
                </div>
              </div>

              <div v-if="fileStore.deletePlan.blocked_count > 0" class="bg-yellow-50 rounded-lg p-4">
                <div class="text-sm text-yellow-800">
                  <span class="font-bold">{{ fileStore.deletePlan.blocked_count }}</span> 个文件被阻止删除
                </div>
                <div class="mt-2 space-y-1">
                  <div
                    v-for="b in fileStore.deletePlan.blocked.slice(0, 5)"
                    :key="b.file_id"
                    class="text-xs text-yellow-700"
                  >
                    {{ b.file_name }} — {{ b.reason }}
                  </div>
                  <div v-if="fileStore.deletePlan.blocked.length > 5" class="text-xs text-yellow-600">
                    ...还有 {{ fileStore.deletePlan.blocked.length - 5 }} 个
                  </div>
                </div>
              </div>

              <p class="text-sm text-gray-500">删除后将同步更新数据库记录和业务状态。此操作不可撤销。</p>
            </div>

            <!-- Step: progress -->
            <div v-if="batchStep === 'progress'" class="space-y-4">
              <div class="text-center py-4">
                <svg class="animate-spin h-8 w-8 mx-auto mb-3 text-blue-500" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p class="text-gray-700 font-medium">正在安全擦除磁盘文件并更新业务索引...</p>
              </div>

              <div v-if="fileStore.deleteTaskStatus" class="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
                <div class="flex justify-between">
                  <span>总文件数</span>
                  <span class="font-medium">{{ fileStore.deleteTaskStatus.total_count }}</span>
                </div>
                <div class="flex justify-between">
                  <span>已删除</span>
                  <span class="font-medium text-green-600">{{ fileStore.deleteTaskStatus.deleted_count }}</span>
                </div>
                <div class="flex justify-between">
                  <span>已阻止</span>
                  <span class="font-medium text-yellow-600">{{ fileStore.deleteTaskStatus.blocked_count }}</span>
                </div>
                <div class="flex justify-between">
                  <span>失败</span>
                  <span class="font-medium text-red-600">{{ fileStore.deleteTaskStatus.failed_count }}</span>
                </div>
                <!-- 进度条 -->
                <div class="w-full bg-gray-200 rounded-full h-2 mt-2">
                  <div
                    class="bg-blue-500 h-2 rounded-full transition-all duration-300"
                    :style="{
                      width: (fileStore.deleteTaskStatus.total_count > 0
                        ? ((fileStore.deleteTaskStatus.deleted_count + fileStore.deleteTaskStatus.blocked_count + fileStore.deleteTaskStatus.failed_count) / fileStore.deleteTaskStatus.total_count) * 100
                        : 0) + '%'
                    }"
                  />
                </div>
              </div>
            </div>

            <!-- Step: result -->
            <div v-if="batchStep === 'result' && batchTaskStatus" class="space-y-4">
              <div class="bg-green-50 rounded-lg p-4">
                <div class="text-sm text-green-800 font-medium">删除完成</div>
              </div>

              <div class="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
                <div class="flex justify-between">
                  <span>成功删除</span>
                  <span class="font-medium text-green-600">{{ batchTaskStatus.deleted_count }}</span>
                </div>
                <div class="flex justify-between">
                  <span>被阻止</span>
                  <span class="font-medium text-yellow-600">{{ batchTaskStatus.blocked_count }}</span>
                </div>
                <div class="flex justify-between">
                  <span>失败</span>
                  <span class="font-medium text-red-600">{{ batchTaskStatus.failed_count }}</span>
                </div>
                <div class="flex justify-between">
                  <span>实际释放空间</span>
                  <span class="font-medium">{{ formatBytes(batchTaskStatus.actual_release_size) }}</span>
                </div>
              </div>

              <!-- 失败文件列表 -->
              <div v-if="batchTaskStatus.results?.some(r => r.result === 'failed' || r.result === 'blocked')">
                <div class="text-sm font-medium text-gray-700 mb-2">失败/阻止详情</div>
                <div class="space-y-1 max-h-40 overflow-y-auto">
                  <div
                    v-for="r in batchTaskStatus.results.filter(r => r.result === 'failed' || r.result === 'blocked')"
                    :key="r.file_id"
                    class="text-xs bg-red-50 rounded p-2"
                  >
                    <span class="text-red-700">{{ r.file_path.split('/').pop() }}</span>
                    <span class="text-red-500 ml-2">{{ r.error }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 底部按钮 -->
          <div class="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
            <button
              v-if="batchStep === 'confirm'"
              class="px-4 py-2 text-sm rounded-lg border border-gray-200 hover:bg-gray-50"
              @click="closeBatchDialog"
            >
              取消
            </button>
            <button
              v-if="batchStep === 'confirm'"
              class="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700"
              :disabled="fileStore.deleteExecuting"
              @click="confirmBatchDelete"
            >
              确认删除
            </button>
            <button
              v-if="batchStep === 'result'"
              class="px-4 py-2 text-sm rounded-lg bg-gray-800 text-white hover:bg-gray-900"
              @click="closeBatchDialog"
            >
              完成
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
