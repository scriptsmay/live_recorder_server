<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ReplayRecordStatus } from '@/types/api'

const props = defineProps<{
  recordId: number
  status: ReplayRecordStatus | string
  busy?: boolean
  running?: boolean
}>()

const emit = defineEmits<{
  action: [recordId: number, action: string]
  cancel: [recordId: number]
}>()

interface ActionDef {
  action: string
  label: string
}

const moreValue = ref('')

const actionDefs: Record<string, ActionDef> = {
  refresh: { action: 'refresh', label: '刷新' },
  extract: { action: 'extract', label: '提取' },
  download: { action: 'download', label: '下载' },
  cut: { action: 'cut', label: '剪切' },
  fix: { action: 'fix', label: '修复' },
  upload: { action: 'upload', label: '投稿' },
  'mark-completed': { action: 'mark-completed', label: '标记完成' },
  all: { action: 'all', label: '全流程' },
}

const actionOrder = [
  'refresh',
  'extract',
  'download',
  'cut',
  'fix',
  'upload',
  'all',
  'mark-completed',
]

const primaryAction = computed<ActionDef | null>(() => {
  if (props.running) return null
  if (props.status === 'pending' || props.status === 'failed' || props.status === 'cancelled') {
    return actionDefs.extract
  }
  if (props.status === 'extracted') return actionDefs.download
  if (props.status === 'downloaded') return actionDefs.cut
  if (props.status === 'cut' || props.status === 'fixed') return actionDefs.upload
  return null
})

const moreActions = computed(() =>
  actionOrder
    .filter((action) => action !== primaryAction.value?.action)
    .filter((action) => props.status !== 'completed' || action !== 'mark-completed')
    .map((action) => actionDefs[action]),
)

function handleClick(action: string) {
  emit('action', props.recordId, action)
}

function handleMoreChange() {
  if (!moreValue.value) return
  handleClick(moreValue.value)
  moreValue.value = ''
}

function handleCancel() {
  emit('cancel', props.recordId)
}
</script>

<template>
  <div class="inline-flex justify-end gap-1.5">
    <button
      v-if="running"
      class="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
      :disabled="busy"
      @click="handleCancel"
    >
      取消
    </button>
    <button
      v-if="primaryAction"
      class="min-w-14 px-2 py-1 text-xs rounded bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50"
      :disabled="busy || running"
      @click="handleClick(primaryAction.action)"
    >
      {{ primaryAction.label }}
    </button>
    <select
      v-if="!running"
      v-model="moreValue"
      class="w-20 px-2 py-1 text-xs rounded border border-gray-300 text-gray-600 bg-white hover:bg-gray-50 transition-colors disabled:opacity-50"
      :disabled="busy"
      @change="handleMoreChange"
    >
      <option value="">更多</option>
      <option v-for="action in moreActions" :key="action.action" :value="action.action">
        {{ action.label }}
      </option>
    </select>
  </div>
</template>
