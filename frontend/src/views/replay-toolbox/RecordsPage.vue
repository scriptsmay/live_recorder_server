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

const totalPages = computed(() => Math.max(1, Math.ceil(store.total / store.pageSize)))

onMounted(async () => {
  store.selectedPrincipalId = principalId.value
  await Promise.all([
    store.fetchRecords({ status: statusFilter.value, page: 1 }),
    store.fetchUploads(),
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
  } else {
    const ok = await confirm(`确认执行 ${action} 任务？`, { title: `回放 #${recordId}` })
    if (!ok) return
  }
  await store.enqueueRecord(recordId, action)
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
      @show-detail="selectedRecord = $event"
      @action="handleAction"
      @page-change="handlePageChange"
    />

    <ReplayRecordDetail
      v-if="selectedRecord"
      :record="selectedRecord"
      @close="selectedRecord = null"
    />
  </div>
</template>
