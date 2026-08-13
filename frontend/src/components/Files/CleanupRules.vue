<script setup lang="ts">
/**
 * 清理规则标签页
 * 预设规则模板，选择后调用 delete-plan API 生成 dry-run 结果
 */
import { ref, computed } from 'vue'
import { useFileStore } from '@/stores/file-manage'
import { formatBytes } from '@/utils/lib'
import type { DeletePlan, DeleteTaskStatus, FileType, FileCategory } from '@/types/file-manage'

const fileStore = useFileStore()

interface CleanupRule {
  id: string
  name: string
  description: string
  icon: string
  filters: {
    category?: FileCategory
    type?: FileType
    safe_to_delete?: boolean
    older_than_days?: number
    exists_on_disk?: boolean
    status?: string
  }
}

const rules: CleanupRule[] = [
  {
    id: 'hls-old',
    name: '过期 HLS 分片',
    description: '删除超过 N 天的 HLS 目录分片文件',
    icon: 'M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0-.5 1.5 1.5m0 0 1-3',
    filters: { type: 'hls_directory', safe_to_delete: true },
  },
  {
    id: 'recording-old',
    name: '过期录制原始文件',
    description: '删除超过 N 天且可安全删除的直播录制文件',
    icon: 'm15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z',
    filters: { category: 'recording', type: 'recording_file', safe_to_delete: true },
  },
  {
    id: 'replay-old',
    name: '过期回放中间文件',
    description: '删除超过 N 天且可安全删除的回放切片/修复/原始文件',
    icon: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    filters: { category: 'replay', safe_to_delete: true },
  },
  {
    id: 'missing-files',
    name: '标记缺失文件',
    description: '扫描并标记数据库中已不存在于磁盘的文件',
    icon: 'M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z',
    filters: { exists_on_disk: false, status: 'active' },
  },
]

const selectedRule = ref<CleanupRule | null>(null)
const olderThanDays = ref(7)
const scanLoading = ref(false)
const batchStep = ref<'idle' | 'plan' | 'confirm' | 'progress' | 'result'>('idle')
const deletePlan = ref<DeletePlan | null>(null)
const deleteTaskStatus = ref<DeleteTaskStatus | null>(null)

async function selectRule(rule: CleanupRule) {
  selectedRule.value = rule
  batchStep.value = 'plan'
  deletePlan.value = null
  deleteTaskStatus.value = null

  const filters: Record<string, unknown> = { ...rule.filters }
  if (rule.filters.safe_to_delete || rule.filters.category || rule.filters.type === 'hls_directory') {
    filters.older_than_days = olderThanDays.value
  }
  const plan = await fileStore.generateDeletePlan({ filters })
  if (plan) {
    deletePlan.value = plan
    batchStep.value = 'confirm'
  } else {
    batchStep.value = 'idle'
  }
}

async function confirmDelete() {
  if (!deletePlan.value) return
  batchStep.value = 'progress'

  const taskId = await fileStore.executeDelete(deletePlan.value.plan_id)
  if (!taskId) {
    batchStep.value = 'idle'
    return
  }

  fileStore.startPollingDeleteTask(taskId, (status) => {
    deleteTaskStatus.value = status
    batchStep.value = 'result'
    fileStore.fetchSummary()
  })

  await fileStore.fetchDeleteTaskStatus(taskId)
}

function closeResult() {
  fileStore.stopPollingDeleteTask()
  batchStep.value = 'idle'
  selectedRule.value = null
}

function cancelConfirm() {
  batchStep.value = 'idle'
  selectedRule.value = null
}

async function handleScan() {
  scanLoading.value = true
  try {
    await fileStore.triggerScan()
  } finally {
    scanLoading.value = false
  }
}

const totalMatched = computed(() => {
  if (!deletePlan.value) return 0
  return deletePlan.value.deletable_count + deletePlan.value.blocked_count
})
</script>

<template>
  <div class="space-y-6">
    <!-- 规则选择 -->
    <section>
      <header class="flex items-center justify-between mb-4">
        <div>
          <h2 class="text-lg font-bold text-gray-900">清理规则</h2>
          <p class="text-sm text-gray-500 mt-1">
            选择规则后系统会自动匹配文件并生成删除计划，确认后执行批量清理
          </p>
        </div>
        <button
          class="px-3 py-2 text-sm rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
          :disabled="scanLoading"
          @click="handleScan"
        >
          <svg v-if="scanLoading" class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          重新扫描
        </button>
      </header>

      <div class="flex items-center gap-3 mb-4 p-3 bg-gray-50 rounded-lg">
        <label class="text-sm text-gray-600">保留天数:</label>
        <select
          v-model="olderThanDays"
          class="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
        >
          <option :value="3">3 天</option>
          <option :value="7">7 天</option>
          <option :value="14">14 天</option>
          <option :value="30">30 天</option>
          <option :value="60">60 天</option>
          <option :value="90">90 天</option>
        </select>
        <span class="text-xs text-gray-400">超过此天数的文件将被匹配</span>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <button
          v-for="rule in rules"
          :key="rule.id"
          class="text-left p-4 rounded-xl border border-gray-200 bg-white hover:border-brand-400 hover:shadow-sm transition-all group"
          :class="selectedRule?.id === rule.id ? 'border-brand-500 ring-1 ring-brand-200' : ''"
          @click="selectRule(rule)"
        >
          <div class="flex items-start gap-3">
            <div
              class="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 group-hover:bg-brand-50 transition-colors"
            >
              <svg
                class="w-5 h-5 text-gray-500 group-hover:text-brand-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="1.5"
                  :d="rule.icon"
                />
              </svg>
            </div>
            <div class="min-w-0">
              <div class="font-medium text-gray-900 text-sm">{{ rule.name }}</div>
              <div class="text-xs text-gray-500 mt-1">{{ rule.description }}</div>
            </div>
          </div>
        </button>
      </div>
    </section>

    <!-- Loading -->
    <Transition name="fade">
      <div v-if="batchStep === 'plan'" class="text-center py-8">
        <svg
          class="animate-spin h-8 w-8 mx-auto mb-3 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          />
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        <p class="text-gray-500">正在扫描匹配文件...</p>
      </div>
    </Transition>

    <!-- Confirm -->
    <Transition name="fade">
      <section
        v-if="batchStep === 'confirm' && deletePlan"
        class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
      >
        <header class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 class="font-bold text-gray-900">{{ selectedRule?.name }} — 删除计划</h3>
          <button class="text-gray-400 hover:text-gray-600" @click="cancelConfirm">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </header>

        <div class="px-6 py-4 space-y-4">
          <!-- Stats -->
          <div class="grid grid-cols-3 gap-4">
            <div class="bg-green-50 rounded-lg p-3 text-center">
              <div class="text-2xl font-bold text-green-700">{{ deletePlan.deletable_count }}</div>
              <div class="text-xs text-green-600">可删除</div>
            </div>
            <div class="bg-yellow-50 rounded-lg p-3 text-center">
              <div class="text-2xl font-bold text-yellow-700">{{ deletePlan.blocked_count }}</div>
              <div class="text-xs text-yellow-600">被阻止</div>
            </div>
            <div class="bg-blue-50 rounded-lg p-3 text-center">
              <div class="text-2xl font-bold text-blue-700">
                {{ formatBytes(deletePlan.total_size) }}
              </div>
              <div class="text-xs text-blue-600">预计释放</div>
            </div>
          </div>

          <p v-if="totalMatched === 0" class="text-center py-6 text-gray-400">没有匹配的文件</p>

          <div v-if="deletePlan.deletable.length > 0">
            <p class="text-sm font-medium text-gray-700">将删除以下文件:</p>
            <ul class="max-h-48 overflow-y-auto space-y-1">
              <li
                v-for="f in deletePlan.deletable.slice(0, 20)"
                :key="f.file_id"
                class="flex items-center justify-between text-xs bg-green-50 rounded px-3 py-1.5"
              >
                <span class="text-green-800 truncate mr-2">{{
                  f.file_name || f.file_path.split('/').pop()
                }}</span>
                <span class="text-green-600 shrink-0">{{ formatBytes(f.file_size || 0) }}</span>
              </li>
              <li
                v-if="deletePlan.deletable.length > 20"
                class="text-xs text-gray-400 text-center py-1"
              >
                ...还有 {{ deletePlan.deletable.length - 20 }} 个文件
              </li>
            </ul>
          </div>

          <div v-if="deletePlan.blocked.length > 0">
            <p class="text-sm font-medium text-gray-700">以下文件被阻止:</p>
            <ul class="max-h-32 overflow-y-auto space-y-1">
              <li
                v-for="b in deletePlan.blocked.slice(0, 10)"
                :key="b.file_id"
                class="flex items-center justify-between text-xs bg-yellow-50 rounded px-3 py-1.5"
              >
                <span class="text-yellow-800 truncate mr-2">{{
                  b.file_name || b.file_path.split('/').pop()
                }}</span>
                <span class="text-yellow-600 shrink-0">{{ b.reason }}</span>
              </li>
              <li
                v-if="deletePlan.blocked.length > 10"
                class="text-xs text-gray-400 text-center py-1"
              >
                ...还有 {{ deletePlan.blocked.length - 10 }} 个
              </li>
            </ul>
          </div>
        </div>

        <footer class="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
          <button
            class="px-4 py-2 text-sm rounded-lg border border-gray-200 hover:bg-gray-50"
            @click="cancelConfirm"
          >
            取消
          </button>
          <button
            v-if="deletePlan.deletable_count > 0"
            class="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700"
            :disabled="fileStore.deleteExecuting"
            @click="confirmDelete"
          >
            确认删除 {{ deletePlan.deletable_count }} 个文件
          </button>
        </footer>
      </section>
    </Transition>

    <!-- Progress -->
    <Transition name="fade">
      <section
        v-if="batchStep === 'progress'"
        class="bg-white rounded-xl border border-gray-200 shadow-sm p-6"
      >
        <div class="text-center py-4">
          <svg
            class="animate-spin h-8 w-8 mx-auto mb-3 text-blue-500"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <p class="text-gray-700 font-medium">正在执行清理...</p>
          <p class="text-sm text-gray-500 mt-1">请勿关闭页面</p>
        </div>
        <dl
          v-if="fileStore.deleteTaskStatus"
          class="mt-4 bg-gray-50 rounded-lg p-4 space-y-2 text-sm"
        >
          <div class="flex justify-between">
            <dt>总文件数</dt>
            <dd class="font-medium">{{ fileStore.deleteTaskStatus.total_count }}</dd>
          </div>
          <div class="flex justify-between">
            <dt>已删除</dt>
            <dd class="font-medium text-green-600">
              {{ fileStore.deleteTaskStatus.deleted_count }}
            </dd>
          </div>
          <div class="flex justify-between">
            <dt>已阻止</dt>
            <dd class="font-medium text-yellow-600">
              {{ fileStore.deleteTaskStatus.blocked_count }}
            </dd>
          </div>
          <div class="flex justify-between">
            <dt>失败</dt>
            <dd class="font-medium text-red-600">{{ fileStore.deleteTaskStatus.failed_count }}</dd>
          </div>
          <div class="w-full bg-gray-200 rounded-full h-2 mt-2">
            <div
              class="bg-blue-500 h-2 rounded-full transition-all duration-300"
              :style="{
                width:
                  (fileStore.deleteTaskStatus.total_count > 0
                    ? ((fileStore.deleteTaskStatus.deleted_count +
                        fileStore.deleteTaskStatus.blocked_count +
                        fileStore.deleteTaskStatus.failed_count) /
                        fileStore.deleteTaskStatus.total_count) *
                      100
                    : 0) + '%',
              }"
            />
          </div>
        </dl>
      </section>
    </Transition>

    <!-- Result -->
    <Transition name="fade">
      <section
        v-if="batchStep === 'result' && deleteTaskStatus"
        class="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4"
      >
        <div class="bg-green-50 rounded-lg p-4">
          <p class="text-sm text-green-800 font-medium">清理完成</p>
        </div>
        <dl class="grid grid-cols-2 gap-4">
          <div class="bg-gray-50 rounded-lg p-3">
            <dt class="text-xs text-gray-500">成功删除</dt>
            <dd class="text-xl font-bold text-green-700">{{ deleteTaskStatus.deleted_count }}</dd>
          </div>
          <div class="bg-gray-50 rounded-lg p-3">
            <dt class="text-xs text-gray-500">实际释放</dt>
            <dd class="text-xl font-bold text-blue-700">
              {{ formatBytes(deleteTaskStatus.actual_release_size) }}
            </dd>
          </div>
          <div class="bg-gray-50 rounded-lg p-3">
            <dt class="text-xs text-gray-500">被阻止</dt>
            <dd class="text-xl font-bold text-yellow-700">{{ deleteTaskStatus.blocked_count }}</dd>
          </div>
          <div class="bg-gray-50 rounded-lg p-3">
            <dt class="text-xs text-gray-500">失败</dt>
            <dd class="text-xl font-bold text-red-700">{{ deleteTaskStatus.failed_count }}</dd>
          </div>
        </dl>
        <div
          v-if="
            deleteTaskStatus.results?.some((r) => r.result === 'failed' || r.result === 'blocked')
          "
        >
          <p class="text-sm font-medium text-gray-700">失败/阻止详情</p>
          <ul class="space-y-1 max-h-40 overflow-y-auto">
            <li
              v-for="r in deleteTaskStatus.results.filter(
                (r) => r.result === 'failed' || r.result === 'blocked',
              )"
              :key="r.file_id"
              class="text-xs bg-red-50 rounded p-2"
            >
              <span class="text-red-700">{{ r.file_path.split('/').pop() }}</span>
              <span class="text-red-500 ml-2">{{ r.error }}</span>
            </li>
          </ul>
        </div>
        <div class="flex justify-end">
          <button
            class="px-4 py-2 text-sm rounded-lg bg-gray-800 text-white hover:bg-gray-900"
            @click="closeResult"
          >
            完成
          </button>
        </div>
      </section>
    </Transition>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
