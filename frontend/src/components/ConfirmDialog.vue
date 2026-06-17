<script setup lang="ts">
import { useConfirm } from '@/utils/confirm'

const { confirmState, onConfirm, onCancel } = useConfirm()
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="confirmState.visible"
        class="fixed inset-0 z-[9998] flex items-center justify-center"
        @click.self="onCancel"
      >
        <!-- 遮罩层 -->
        <div class="absolute inset-0 bg-black/40" />

        <!-- 对话框 -->
        <div class="relative bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
          <!-- 头部 -->
          <div class="px-6 pt-5 pb-3">
            <h3 class="text-lg font-semibold text-gray-900">
              {{ confirmState.title }}
            </h3>
          </div>

          <!-- 内容 -->
          <div class="px-6 pb-4">
            <p class="confirm-message text-sm text-gray-600 leading-relaxed">
              {{ confirmState.message }}
            </p>
          </div>

          <!-- 操作按钮 -->
          <div class="px-6 py-4 bg-gray-50 flex justify-end gap-3">
            <button
              class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              @click="onCancel"
            >
              {{ confirmState.cancelText }}
            </button>
            <button
              class="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors"
              @click="onConfirm"
            >
              {{ confirmState.confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
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
.confirm-message {
  white-space: pre-line;
  word-break: break-word;
}
</style>
