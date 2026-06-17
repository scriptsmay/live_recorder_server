<script setup lang="ts">
const statusFilter = defineModel<string>('statusFilter', { default: 'all' })
const dateFrom = defineModel<string>('dateFrom', { default: '' })
const dateTo = defineModel<string>('dateTo', { default: '' })

defineProps<{
  disabled?: boolean
}>()

const emit = defineEmits<{
  change: []
  clearDate: []
}>()

const statusOptions = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待处理' },
  { value: 'extracted', label: '已提取' },
  { value: 'downloaded', label: '已下载' },
  { value: 'cut', label: '已剪切' },
  { value: 'fixed', label: '已修复' },
  { value: 'uploaded', label: '已投稿' },
  { value: 'completed', label: '已完成' },
  { value: 'backed_up', label: '已备份' },
  { value: 'failed', label: '失败' },
]

function handleStatusChange(value: string) {
  statusFilter.value = value
  emit('change')
}

function handleDateChange() {
  emit('change')
}

function handleClearDate() {
  dateFrom.value = ''
  dateTo.value = ''
  emit('clearDate')
}
</script>

<template>
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
          :disabled="disabled"
          @click="handleStatusChange(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-gray-500 shrink-0">时间：</span>
        <input
          v-model="dateFrom"
          type="date"
          class="px-2 py-1 text-xs border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-brand-500"
          :disabled="disabled"
          @change="handleDateChange"
        />
        <span class="text-xs text-gray-400">-</span>
        <input
          v-model="dateTo"
          type="date"
          class="px-2 py-1 text-xs border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-brand-500"
          :disabled="disabled"
          @change="handleDateChange"
        />
        <button
          v-if="dateFrom || dateTo"
          class="px-2 py-1 text-xs text-gray-500 hover:text-gray-700"
          @click="handleClearDate"
        >
          清除
        </button>
      </div>
    </div>
  </div>
</template>
