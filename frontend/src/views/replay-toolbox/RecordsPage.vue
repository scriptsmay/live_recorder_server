<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useReplayToolboxStore } from '@/stores/replay-toolbox'
import { useConfirm } from '@/utils/confirm'
import type { ReplayRecord } from '@/types/api'
import ReplayFilterBar from '@/components/replay/ReplayFilterBar.vue'
import ReplayRecordTable from '@/components/replay/ReplayRecordTable.vue'
import ReplayRecordDetail from '@/components/replay/ReplayRecordDetail.vue'

const route = useRoute()
const store = useReplayToolboxStore()
const { confirm } = useConfirm()

const principalId = computed(() => route.params.principalId as string)

const statusFilter = ref('all')
const batchCount = ref(1)
const selectedRecord = ref<ReplayRecord | null>(null)

const forceDialogVisible = ref(false)
const forceDialogMessage = ref('')
const forceDialogTitle = ref('')
const forceChecked = ref(false)
let forceResolve: ((value: { confirmed: boolean; force: boolean }) => void) | null = null

function showForceConfirm(message: string, title: string): Promise<{ confirmed: boolean; force: boolean }> {
  forceDialogMessage.value = message
  forceDialogTitle.value = title
  forceChecked.value = false
  forceDialogVisible.value = true
  return new Promise((resolve) => {
    forceResolve = resolve
  })
}

function onForceConfirm() {
  forceDialogVisible.value = false
  forceResolve?.({ confirmed: true, force: forceChecked.value })
  forceResolve = null
}

function onForceCancel() {
  forceDialogVisible.value = false
  forceResolve?.({ confirmed: false, force: false })
  forceResolve = null
}

const totalPages = computed(() => Math.max(1, Math.ceil(store.total / store.pageSize)))
const activeRecordIds = computed(
  () => new Set((store.taskStatus?.active ?? []).map((task) => task.record_id)),
)

onMounted(async () => {
  store.selectedPrincipalId = principalId.value
  await Promise.all([
    store.fetchRecords({ status: statusFilter.value, page: 1 }),
    store.fetchUploads(),
    store.fetchTaskStatus(),
  ])
})

watch(principalId, async (id) => {
  store.selectedPrincipalId = id
  await store.fetchRecords({ status: statusFilter.value, page: 1 })
})

async function handleFilterChange() {
  await store.fetchRecords({ status: statusFilter.value, page: 1 })
}

async function handleClearDateFilter() {
  store.dateFrom = ''
  store.dateTo = ''
  await store.fetchRecords({ status: statusFilter.value, page: 1 })
}

async function handleBatchAll() {
  const ok = await confirm(`同步最近 ${batchCount.value} 条回放记录并加入全流程处理？`)
  if (!ok) return
  await store.syncRecords(batchCount.value)
  await store.enqueuePrincipal(batchCount.value)
}

async function handleAction(recordId: number, action: string) {
  if (action === 'upload' || action === 'all') {
    try {
      const preview = await store.fetchUploadPreview(recordId)
      if (!preview) {
        const ok = await confirm('无法获取投稿预览，仍要继续？', { title: `回放 #${recordId}` })
        if (!ok) return
      } else {
        const descText =
          preview.desc_full && preview.desc_full.length > 100
            ? `【简介】${preview.desc}（完整简介见投稿模板）`
            : `【简介】${preview.desc || '（无）'}`
        const message = [
          '【投稿标题】',
          `  ${preview.title || '（无）'}`,
          '',
          `【标签】 ${preview.tags || '（无）'}`,
          '',
          descText,
          '',
          `模板：${preview.template_name || '（无）'}`,
          '',
          `确认执行 ${action}？`,
        ].join('\n')
        const ok = await confirm(message, { title: `回放 #${recordId} 投稿预览` })
        if (!ok) return
      }
    } catch {
      const ok = await confirm('投稿预览获取失败，仍要继续？', { title: `回放 #${recordId}` })
      if (!ok) return
    }
    await store.enqueueRecord(recordId, action)
  } else {
    const { confirmed, force } = await showForceConfirm(`确认执行 ${action} 任务？`, `回放 #${recordId}`)
    if (!confirmed) return
    await store.enqueueRecord(recordId, action, force)
  }
}

async function handleCancel(recordId: number) {
  const ok = await confirm('确定取消当前回放任务？', { title: `回放 #${recordId}` })
  if (!ok) return
  await store.cancelRecord(recordId)
}

async function handlePageChange(delta: number) {
  const next = Math.min(totalPages.value, Math.max(1, store.page + delta))
  if (next === store.page) return
  await store.fetchRecords({ status: statusFilter.value, page: next })
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex items-center gap-2 ml-auto">
        <input
          v-model.number="batchCount"
          type="number"
          min="1"
          max="20"
          class="w-20 px-2 py-1.5 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-brand-500"
        />
        <button
          class="px-3 py-1.5 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          :disabled="store.busy"
          @click="handleBatchAll()"
        >
          批量全流程
        </button>
      </div>
    </div>

    <ReplayFilterBar
      v-model:status-filter="statusFilter"
      v-model:date-from="store.dateFrom"
      v-model:date-to="store.dateTo"
      :disabled="false"
      @change="handleFilterChange"
      @clear-date="handleClearDateFilter"
    />

    <ReplayRecordTable
      :records="store.records"
      :loading="store.loadingRecords"
      :page="store.page"
      :total-pages="totalPages"
      :total="store.total"
      :busy="store.busy"
      :active-record-ids="activeRecordIds"
      @show-detail="selectedRecord = $event"
      @action="handleAction"
      @cancel="handleCancel"
      @page-change="handlePageChange"
    />

    <ReplayRecordDetail
      v-if="selectedRecord"
      :record="selectedRecord"
      @close="selectedRecord = null"
    />

    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="forceDialogVisible"
          class="fixed inset-0 z-[9998] flex items-center justify-center"
          @click.self="onForceCancel"
        >
          <div class="absolute inset-0 bg-black/40" />
          <div class="relative bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
            <div class="px-6 pt-5 pb-3">
              <h3 class="text-lg font-semibold text-gray-900">{{ forceDialogTitle }}</h3>
            </div>
            <div class="px-6 pb-4">
              <p class="text-sm text-gray-600 leading-relaxed whitespace-pre-line break-words">
                {{ forceDialogMessage }}
              </p>
              <label class="flex items-center gap-2 mt-4 cursor-pointer select-none">
                <input
                  v-model="forceChecked"
                  type="checkbox"
                  class="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                />
                <span class="text-sm text-gray-700">强制重写（忽略已有缓存产物）</span>
              </label>
            </div>
            <div class="px-6 py-4 bg-gray-50 flex justify-end gap-3">
              <button
                class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                @click="onForceCancel"
              >
                取消
              </button>
              <button
                class="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors"
                @click="onForceConfirm"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.modal-enter-active {
  transition: all 0.2s ease-out;
}
.modal-leave-active {
  transition: all 0.15s ease-in;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from > div:last-child {
  transform: scale(0.95);
}
</style>
