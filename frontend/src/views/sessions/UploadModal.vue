<script setup lang="ts">
/**
 * UploadModal - 投稿录制会话弹窗
 *
 * 选择投稿模板并提交投稿请求，支持 loading 状态和错误提示。
 *
 * 设计：与 Sessions.vue 保持 Linear Aesthetic —— 玻璃遮罩 + 超细描边卡片 +
 * 图标化头部 + 吸底操作栏。
 */
import { ref, watch } from 'vue'
import { apiGet, apiPost, ApiError } from '@/utils/api'
import { useConfirm } from '@/utils/confirm'
import type { UploadTemplate } from '@/types/api'

const props = defineProps<{
  open: boolean
  sessionId: number | null
  templates: UploadTemplate[]
}>()

const emit = defineEmits<{
  close: []
  submitted: [message: string]
  error: [message: string]
}>()

const { confirm } = useConfirm()

const fieldClass =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-all focus:border-brand-500 focus:ring-2 focus:ring-brand-500/50'

// ---- Local State ----
const localTemplates = ref<UploadTemplate[]>([])
const selectedTemplateId = ref<string>('')
const submitting = ref(false)
const errorMsg = ref('')

// Use parent templates if available, otherwise fetch locally
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      selectedTemplateId.value = ''
      errorMsg.value = ''
      submitting.value = false

      if (props.templates.length > 0) {
        localTemplates.value = props.templates
      } else {
        await fetchTemplates()
      }
    }
  },
)

async function fetchTemplates() {
  try {
    const res = await apiGet<UploadTemplate[]>('/api/upload_templates')
    localTemplates.value = res.data || []
  } catch (err) {
    errorMsg.value = '加载模板失败: ' + (err instanceof ApiError ? err.message : String(err))
  }
}

async function handleSubmit() {
  if (!selectedTemplateId.value || !props.sessionId) return

  const ok = await confirm('确认投稿？')
  if (!ok) return

  submitting.value = true
  errorMsg.value = ''

  try {
    const res = await apiPost<{ status: string; message?: string }>(
      `/api/sessions/${props.sessionId}/upload`,
      {
        template_id: parseInt(selectedTemplateId.value, 10),
      },
    )
    if (res.status !== 'ok') {
      errorMsg.value = res.message || '投稿失败'
      emit('error', errorMsg.value)
    } else {
      emit('submitted', res.message || '投稿任务已提交')
    }
  } catch (err) {
    errorMsg.value = err instanceof ApiError ? err.message : String(err)
    emit('error', errorMsg.value)
  } finally {
    submitting.value = false
  }
}

function handleOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget && !submitting.value) {
    emit('close')
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="open"
        class="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm"
        @click="handleOverlayClick"
      >
        <div class="hairline-card w-full max-w-md overflow-hidden rounded-2xl shadow-2xl">
          <!-- 头部 -->
          <div class="flex items-center gap-3 border-b border-gray-200/70 px-6 py-4">
            <span
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-brand-500/10 text-brand-600"
            >
              <svg
                class="h-4 w-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 16.5V4.5m0 0L7.5 9M12 4.5 16.5 9M3.75 19.5h16.5"
                />
              </svg>
            </span>
            <div class="min-w-0 flex-1">
              <h3 class="text-base font-semibold tracking-tight text-gray-900">投稿录制会话</h3>
              <p class="mt-0.5 text-xs text-gray-400">
                {{ sessionId ? `会话 #${sessionId} · 选择模板后提交` : '选择模板后提交投稿' }}
              </p>
            </div>
            <button
              class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
              :disabled="submitting"
              @click="emit('close')"
            >
              <svg
                class="h-5 w-5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- 主体 -->
          <div class="space-y-4 px-6 py-5">
            <!-- 错误提示 -->
            <div
              v-if="errorMsg"
              class="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50/70 p-3 text-sm text-red-600"
            >
              <svg
                class="mt-0.5 h-4 w-4 shrink-0"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
                />
              </svg>
              <span>{{ errorMsg }}</span>
            </div>

            <!-- 模板选择 -->
            <div>
              <label class="mb-1.5 block text-sm font-medium text-gray-700" for="upload-template"
                >选择投稿模板</label
              >
              <select id="upload-template" v-model="selectedTemplateId" :class="fieldClass">
                <option value="" disabled>选择模板投稿</option>
                <option v-for="t in localTemplates" :key="t.id" :value="String(t.id)">
                  {{ t.name }}
                </option>
              </select>
              <p class="mt-1.5 text-xs text-gray-400">投稿将使用该模板的标题、分区与标签配置</p>
            </div>
          </div>

          <!-- 底栏 -->
          <div
            class="sticky bottom-0 flex items-center justify-end gap-3 border-t border-gray-200/70 bg-surface/85 px-6 py-4 backdrop-blur-xl"
          >
            <button
              class="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="submitting"
              @click="emit('close')"
            >
              取消
            </button>
            <button
              class="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-brand-700 glow-accent disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!selectedTemplateId || submitting"
              @click="handleSubmit"
            >
              <svg v-if="submitting" class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  class="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  stroke-width="4"
                />
                <path
                  class="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z"
                />
              </svg>
              {{ submitting ? '投稿中...' : '提交投稿' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
