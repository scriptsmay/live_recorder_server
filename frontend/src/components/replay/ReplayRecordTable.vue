<script setup lang="ts">
import { computed, provide, ref } from 'vue'
import type { ReplayRecord } from '@/types/api'
import { displayDuration } from '@/utils/lib'

import ReplayStatusBadge from './ReplayStatusBadge.vue'
import ReplayActionButton from './ReplayActionButton.vue'

const activeDropdownId = ref<number | null>(null)
provide('activeDropdownId', activeDropdownId)

const batchMode = ref(false)

const props = defineProps<{
  records: ReplayRecord[]
  loading: boolean
  page: number
  totalPages: number
  total: number
  busy?: boolean
  activeRecordIds?: Set<number>
  selectedRecordIds?: Set<number>
  batchCount?: number
}>()

const emit = defineEmits<{
  showDetail: [record: ReplayRecord]
  action: [recordId: number, action: string]
  cancel: [recordId: number]
  pageChange: [delta: number]
  toggleSelect: [recordId: number, selected: boolean]
  toggleSelectAll: [recordIds: number[], selected: boolean]
  'update:batchCount': [value: number]
  batchMode: [active: boolean]
  batchAll: []
  markSelectedCompleted: []
}>()

const selectedCount = computed(() => props.selectedRecordIds?.size ?? 0)

const localBatchCount = computed({
  get: () => props.batchCount ?? 1,
  set: (v: number) => emit('update:batchCount', v),
})

const pageRecordIds = computed(() => props.records.map((record) => record.id))
const allPageSelected = computed(
  () =>
    pageRecordIds.value.length > 0 &&
    pageRecordIds.value.every((id) => props.selectedRecordIds?.has(id)),
)

const toggleBatchMode = () => {
  batchMode.value = !batchMode.value
  emit('batchMode', batchMode.value)
}

function isSelected(recordId: number) {
  return props.selectedRecordIds?.has(recordId) ?? false
}

function onToggleRecord(event: Event, recordId: number) {
  emit('toggleSelect', recordId, (event.target as HTMLInputElement).checked)
}

function onTogglePage(event: Event) {
  emit('toggleSelectAll', pageRecordIds.value, (event.target as HTMLInputElement).checked)
}
</script>

<template>
  <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
    <div class="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
      <h2 class="text-sm font-semibold text-gray-900">回放记录</h2>
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-2 mr-2">
          <span class="text-xs text-gray-500">同步最新</span>
          <input
            v-model.number="localBatchCount"
            type="number"
            min="1"
            max="20"
            class="w-12 px-2 py-1 text-xs border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-brand-500"
          />
          <span class="text-xs text-gray-500">条记录一键执行</span>
          <button
            class="px-3 py-1 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            :disabled="busy"
            @click="emit('batchAll')"
          >
            批量全流程
          </button>
        </div>
        <template v-if="batchMode">
          <button
            class="px-3 py-1 text-sm font-medium text-white rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50"
            :disabled="busy || selectedCount === 0"
            @click="emit('markSelectedCompleted')"
          >
            标记已完成（{{ selectedCount }}）
          </button>
        </template>
        <button
          class="px-3 py-1 text-sm rounded-lg border transition-colors"
          :class="
            batchMode
              ? 'border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100'
              : 'border-gray-300 text-gray-600 hover:bg-gray-50'
          "
          @click="toggleBatchMode"
        >
          {{ batchMode ? '取消批量' : '批量操作' }}
        </button>
      </div>
    </div>

    <div class="overflow-x-auto">
      <table class="min-w-full divide-y divide-gray-100">
        <thead class="bg-gray-50">
          <tr>
            <th v-if="batchMode" class="px-4 py-2 text-left text-xs font-medium text-gray-500">
              <input
                type="checkbox"
                class="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                :checked="allPageSelected"
                :disabled="loading || records.length === 0 || busy"
                @change="onTogglePage"
              />
            </th>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">ID</th>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">回放时间</th>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">回放</th>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">状态</th>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">时长</th>
            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500">创建时间</th>
            <th class="px-4 py-2 text-right text-xs font-medium text-gray-500">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 bg-white">
          <tr v-if="loading">
            <td :colspan="batchMode ? 8 : 7" class="px-4 py-10 text-center text-sm text-gray-400">
              加载中...
            </td>
          </tr>
          <tr v-else-if="records.length === 0">
            <td :colspan="batchMode ? 8 : 7" class="px-4 py-10 text-center text-sm text-gray-400">
              暂无回放记录
            </td>
          </tr>
          <tr v-for="record in records" v-else :key="record.id" class="hover:bg-gray-50">
            <td v-if="batchMode" class="px-4 py-3 whitespace-nowrap">
              <input
                type="checkbox"
                class="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                :checked="isSelected(record.id)"
                :disabled="busy"
                @click.stop
                @change="onToggleRecord($event, record.id)"
              />
            </td>
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
              {{ record.id }}
            </td>
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
              {{ $formatTime(record.start_time) }}
            </td>
            <td class="px-4 py-3 cursor-pointer" @click="emit('showDetail', record)">
              <div
                class="text-sm font-medium text-brand-400 truncate max-w-[260px] hover:text-brand-600"
              >
                {{ record.video_file_name || record.replay_id || `#${record.id}` }}
              </div>
            </td>
            <td class="px-4 py-3 whitespace-nowrap">
              <ReplayStatusBadge :status="record.status" />
            </td>
            <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
              {{ displayDuration(record.duration) }}
            </td>
            <td class="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
              {{ $formatTime(record.created_at) }}
            </td>
            <td class="px-4 py-3 text-right">
              <ReplayActionButton
                :record-id="record.id"
                :status="record.status"
                :busy="busy"
                :running="activeRecordIds?.has(record.id)"
                @action="(id, a) => emit('action', id, a)"
                @cancel="(id) => emit('cancel', id)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      class="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-sm text-gray-500"
    >
      <span>第 {{ page }} / {{ totalPages }} 页，共 {{ total }} 条</span>
      <div class="flex items-center gap-2">
        <button
          class="px-3 py-1 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
          :disabled="page <= 1"
          @click="emit('pageChange', -1)"
        >
          上一页
        </button>
        <button
          class="px-3 py-1 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
          :disabled="page >= totalPages"
          @click="emit('pageChange', 1)"
        >
          下一页
        </button>
      </div>
    </div>
  </div>
</template>
