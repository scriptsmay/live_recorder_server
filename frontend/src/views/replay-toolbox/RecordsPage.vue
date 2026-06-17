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
const syncCount = ref(1)
const enqueueCount = ref(1)
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

async function handleSync() {
  const ok = await confirm(`同步最近 ${syncCount.value} 条回放记录？`)
  if (!ok) return
  await store.syncRecords(syncCount.value)
}

async function handleEnqueue() {
  const ok = await confirm(`将最近 ${enqueueCount.value} 条未完成回放加入处理队列？`)
  if (!ok) return
  await store.enqueuePrincipal(enqueueCount.value)
}

async function handleAction(recordId: number, action: string) {
  const ok = await confirm(`确认执行 ${action} 任务？`, { title: `回放 #${recordId}` })
  if (!ok) return
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
          v-model.number="syncCount"
          type="number"
          min="1"
          max="20"
          class="w-20 px-2 py-1.5 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-brand-500"
        />
        <button
          class="px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
          :disabled="store.busy"
          @click="handleSync(false)"
        >
          同步回放
        </button>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-model.number="enqueueCount"
          type="number"
          min="1"
          max="20"
          class="w-20 px-2 py-1.5 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-brand-500"
        />
        <button
          class="px-3 py-1.5 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          :disabled="store.busy"
          @click="handleEnqueue(false)"
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
