<script setup lang="ts">
const props = defineProps<{
  recordId: number
  busy?: boolean
}>()

const emit = defineEmits<{
  action: [recordId: number, action: string]
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
  { action: 'extract', label: '提取', borderClass: 'border-gray-300', textClass: 'text-gray-600', hoverClass: 'hover:bg-gray-50' },
  { action: 'download', label: '下载', borderClass: 'border-gray-300', textClass: 'text-gray-600', hoverClass: 'hover:bg-gray-50' },
  { action: 'cut', label: '剪切', borderClass: 'border-gray-300', textClass: 'text-gray-600', hoverClass: 'hover:bg-gray-50' },
  { action: 'fix', label: '修复', borderClass: 'border-gray-300', textClass: 'text-gray-600', hoverClass: 'hover:bg-gray-50' },
  { action: 'upload', label: '投稿', borderClass: 'border-sky-300', textClass: 'text-sky-600', hoverClass: 'hover:bg-sky-50' },
  { action: 'backup', label: '备份', borderClass: 'border-teal-300', textClass: 'text-teal-600', hoverClass: 'hover:bg-teal-50' },
  { action: 'all', label: '全流程', borderClass: '', textClass: '', hoverClass: 'hover:bg-brand-700', primary: true },
]

function handleClick(action: string) {
  emit('action', props.recordId, action)
}
</script>

<template>
  <div class="inline-flex flex-wrap justify-end gap-1.5">
    <button
      v-for="a in actions"
      :key="a.action"
      class="px-2 py-1 text-xs rounded transition-colors disabled:opacity-50"
      :class="
        a.primary
          ? 'bg-brand-600 text-white'
          : `border ${a.borderClass} ${a.textClass} ${a.hoverClass}`
      "
      :disabled="busy"
      @click="handleClick(a.action)"
    >
      {{ a.label }}
    </button>
  </div>
</template>
