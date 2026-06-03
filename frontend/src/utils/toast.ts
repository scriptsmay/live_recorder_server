import { ref } from 'vue'

/**
 * Toast 消息通知
 *
 * 使用响应式 ref 驱动 ToastContainer 组件渲染
 * 用法：
 *   import { useToast } from '@/utils/toast'
 *   const toast = useToast()
 *   toast.success('操作成功')
 *   toast.error('操作失败')
 */

export interface ToastItem {
  id: number
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
}

const toasts = ref<ToastItem[]>([])
let nextId = 0

function addToast(type: ToastItem['type'], message: string, duration = 3000) {
  const id = nextId++
  toasts.value.push({ id, type, message })

  if (duration > 0) {
    setTimeout(() => {
      removeToast(id)
    }, duration)
  }
}

function removeToast(id: number) {
  const index = toasts.value.findIndex((t) => t.id === id)
  if (index !== -1) {
    toasts.value.splice(index, 1)
  }
}

export function useToast() {
  return {
    toasts,
    success: (msg: string) => addToast('success', msg),
    error: (msg: string) => addToast('error', msg, 5000),
    warning: (msg: string) => addToast('warning', msg),
    info: (msg: string) => addToast('info', msg),
    remove: removeToast,
  }
}
