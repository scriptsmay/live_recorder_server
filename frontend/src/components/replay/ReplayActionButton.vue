<script setup lang="ts">
import { computed, inject, ref, watch, type Ref } from 'vue'
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
  colorClass?: string
}

const open = ref(false)
const sharedActiveId = inject<Ref<number | null> | null>('activeDropdownId', null)

// 当其他按钮打开下拉时，自动关闭当前
if (sharedActiveId) {
  watch(sharedActiveId, (id) => {
    if (id !== props.recordId) {
      open.value = false
    }
  })
}

const actionDefs: Record<string, ActionDef> = {
  refresh: { action: 'refresh', label: '刷新' },
  extract: { action: 'extract', label: '提取' },
  download: { action: 'download', label: '下载' },
  cut: { action: 'cut', label: '剪切' },
  fix: { action: 'fix', label: '修复' },
  upload: { action: 'upload', label: '投稿', colorClass: 'text-green-600' },
  'mark-completed': { action: 'mark-completed', label: '标记完成' },
  all: { action: 'all', label: '全流程', colorClass: 'text-red-600' },
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

// 每个操作适用的状态
const actionStatusMap: Record<string, ReplayRecordStatus[] | null> = {
  refresh: null, // 所有状态可用
  extract: ['pending', 'failed', 'cancelled'],
  download: ['extracted'],
  cut: ['downloaded'],
  fix: ['cut', 'fixed'],
  upload: ['cut', 'fixed'],
  all: ['pending', 'extracted', 'downloaded', 'cut', 'fixed', 'failed', 'cancelled'],
  'mark-completed': null, // 所有状态可用（completed 状态单独排除）
}

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
    .filter((action) => {
      // completed/uploaded/backed_up 状态下不显示 mark-completed，但允许所有其他操作重新执行
      if (['completed', 'uploaded', 'backed_up'].includes(props.status))
        return action !== 'mark-completed'
      // 按状态过滤：null 表示所有状态可用
      const validStatuses = actionStatusMap[action]
      if (validStatuses === null) return true
      return validStatuses.includes(props.status as ReplayRecordStatus)
    })
    .map((action) => actionDefs[action]),
)

function handleClick(action: string) {
  open.value = false
  if (sharedActiveId) sharedActiveId.value = null
  emit('action', props.recordId, action)
}

function handleCancel() {
  emit('cancel', props.recordId)
}

function toggleDropdown() {
  if (props.busy || props.running) return
  const next = !open.value
  open.value = next
  if (sharedActiveId) {
    sharedActiveId.value = next ? props.recordId : null
  }
}

function onBlur() {
  // Delay close so click on menu item fires first
  setTimeout(() => {
    open.value = false
    if (sharedActiveId) sharedActiveId.value = null
  }, 150)
}
</script>

<template>
  <div class="inline-flex justify-end gap-1.5">
    <!-- 取消按钮 -->
    <button
      v-if="running"
      class="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-red-200 text-red-600 bg-red-50 hover:bg-red-100 active:bg-red-200 transition-colors disabled:opacity-50"
      :disabled="busy"
      @click="handleCancel"
    >
      <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
      取消
    </button>

    <!-- 主操作按钮 -->
    <button
      v-if="primaryAction"
      class="inline-flex items-center gap-1 min-w-14 px-2.5 py-1 text-xs rounded-md bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 transition-colors shadow-sm disabled:opacity-50"
      :disabled="busy || running"
      @click="handleClick(primaryAction.action)"
    >
      <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M12 5l7 7-7 7" />
      </svg>
      {{ primaryAction.label }}
    </button>

    <!-- 更多/操作下拉菜单 -->
    <div v-if="!running && moreActions.length > 0" class="relative" @blur="onBlur">
      <button
        class="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-gray-200 text-gray-600 bg-white hover:bg-gray-50 hover:border-gray-300 active:bg-gray-100 transition-colors disabled:opacity-50"
        :class="{ 'bg-gray-50 border-gray-300': open }"
        :disabled="busy"
        @click.stop="toggleDropdown"
      >
        {{ primaryAction ? '更多' : '操作' }}
        <svg
          class="w-3 h-3 transition-transform duration-200"
          :class="{ 'rotate-180': open }"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <!-- 下拉菜单 -->
      <Transition
        enter-active-class="transition ease-out duration-150"
        enter-from-class="opacity-0 scale-95 -translate-y-1"
        enter-to-class="opacity-100 scale-100 translate-y-0"
        leave-active-class="transition ease-in duration-100"
        leave-from-class="opacity-100 scale-100 translate-y-0"
        leave-to-class="opacity-0 scale-95 -translate-y-1"
      >
        <div
          v-if="open"
          class="absolute right-0 z-50 mt-1 w-28 bg-white rounded-lg border border-gray-200 shadow-lg ring-1 ring-black/5 py-1"
        >
          <button
            v-for="a in moreActions"
            :key="a.action"
            :class="[
              'w-full text-left px-3 py-1.5 text-xs transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-brand-50',
              a.colorClass ?? 'text-gray-700 hover:text-brand-700',
            ]"
            @click.stop="handleClick(a.action)"
          >
            {{ a.label }}
          </button>
        </div>
      </Transition>
    </div>
  </div>
</template>
