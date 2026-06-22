<script setup lang="ts">
const props = defineProps<{
  recordId: number
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
  borderClass: string
  textClass: string
  hoverClass: string
  primary?: boolean
}

const actions: ActionDef[] = [
  {
    action: 'refresh',
    label: '刷新',
    borderClass: 'border-blue-300',
    textClass: 'text-blue-600',
    hoverClass: 'hover:bg-blue-50',
  },
  {
    action: 'extract',
    label: '提取',
    borderClass: 'border-gray-300',
    textClass: 'text-gray-600',
    hoverClass: 'hover:bg-gray-50',
  },
  {
    action: 'download',
    label: '下载',
    borderClass: 'border-gray-300',
    textClass: 'text-gray-600',
    hoverClass: 'hover:bg-gray-50',
  },
  {
    action: 'cut',
    label: '剪切',
    borderClass: 'border-gray-300',
    textClass: 'text-gray-600',
    hoverClass: 'hover:bg-gray-50',
  },
  {
    action: 'fix',
    label: '修复',
    borderClass: 'border-gray-300',
    textClass: 'text-gray-600',
    hoverClass: 'hover:bg-gray-50',
  },
  {
    action: 'upload',
    label: '投稿',
    borderClass: 'border-sky-300',
    textClass: 'text-sky-600',
    hoverClass: 'hover:bg-sky-50',
  },
  {
    action: 'all',
    label: '全流程',
    borderClass: '',
    textClass: '',
    hoverClass: 'hover:bg-brand-700',
    primary: true,
  },
]

function handleClick(action: string) {
  emit('action', props.recordId, action)
}

function handleCancel() {
  emit('cancel', props.recordId)
}
</script>

<template>
  <div class="inline-flex flex-wrap justify-end gap-1.5">
    <button
      v-if="running"
      class="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
      :disabled="busy"
      @click="handleCancel"
    >
      取消
    </button>
    <button
      v-for="a in actions"
      :key="a.action"
      class="px-2 py-1 text-xs rounded transition-colors disabled:opacity-50"
      :class="
        a.primary
          ? 'bg-brand-600 text-white'
          : `border ${a.borderClass} ${a.textClass} ${a.hoverClass}`
      "
      :disabled="busy || running"
      @click="handleClick(a.action)"
    >
      {{ a.label }}
    </button>
  </div>
</template>
