<script setup lang="ts">
/**
 * 通用弹窗组件
 * - Teleport 到 body
 * - 点击遮罩关闭
 * - 支持自定义标题和宽度
 */
withDefaults(
  defineProps<{
    visible: boolean
    title?: string
    maxWidth?: string
  }>(),
  {
    title: '',
    maxWidth: 'max-w-3xl',
  },
)

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

function close() {
  emit('update:visible', false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="fixed inset-0 bg-black/40" @click="close" />
      <div
        class="relative bg-white rounded-xl shadow-xl w-full mx-4 max-h-[80vh] flex flex-col"
        :class="maxWidth"
      >
        <div
          v-if="title || $slots.header"
          class="flex items-center justify-between px-6 py-4 border-b border-gray-200"
        >
          <slot name="header">
            <h3 class="text-lg font-semibold text-gray-900">{{ title }}</h3>
          </slot>
          <button class="text-gray-400 hover:text-gray-600 transition-colors" @click="close">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div class="overflow-y-auto flex-1">
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>
