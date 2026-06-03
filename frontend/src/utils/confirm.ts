import { ref } from 'vue'

/**
 * 确认对话框
 *
 * 替代原 Bootstrap Modal 的 showConfirm()
 * 返回 Promise<boolean>，用户点确定返回 true，取消返回 false
 *
 * 用法：
 *   import { useConfirm } from '@/utils/confirm'
 *   const { confirm, confirmState } = useConfirm()
 *   const ok = await confirm('确定要删除吗？')
 */

export interface ConfirmState {
  visible: boolean
  title: string
  message: string
  confirmText: string
  cancelText: string
}

const state = ref<ConfirmState>({
  visible: false,
  title: '提示',
  message: '',
  confirmText: '确定',
  cancelText: '取消',
})

let resolveFn: ((value: boolean) => void) | null = null

export function useConfirm() {
  async function confirm(
    message: string,
    options?: {
      title?: string
      confirmText?: string
      cancelText?: string
    },
  ): Promise<boolean> {
    state.value = {
      visible: true,
      title: options?.title ?? '提示',
      message,
      confirmText: options?.confirmText ?? '确定',
      cancelText: options?.cancelText ?? '取消',
    }

    return new Promise<boolean>((resolve) => {
      resolveFn = resolve
    })
  }

  function onConfirm() {
    state.value.visible = false
    resolveFn?.(true)
    resolveFn = null
  }

  function onCancel() {
    state.value.visible = false
    resolveFn?.(false)
    resolveFn = null
  }

  return {
    confirmState: state,
    confirm,
    onConfirm,
    onCancel,
  }
}
