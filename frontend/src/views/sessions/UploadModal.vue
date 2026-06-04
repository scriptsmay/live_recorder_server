<script setup lang="ts">
/**
 * UploadModal - 投稿录制会话弹窗
 *
 * 选择投稿模板并提交投稿请求
 * 支持 loading 状态和错误提示
 */
import { ref, watch } from 'vue'
import { apiGet, apiPost, ApiError } from '@/utils/api'
import { useConfirm } from '@/utils/confirm'
import type { UploadTemplate } from '@/types/api'

const props = defineProps<{
  open: boolean
  sessionId: number | null
  templates: UploadTemplate[]
  uploadSource?: 'original' | 'danmaku'
}>()

const emit = defineEmits<{
  close: []
  submitted: [message: string]
  error: [message: string]
}>()

const { confirm } = useConfirm()

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
        upload_source: props.uploadSource || 'original',
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
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      @click="handleOverlayClick"
    >
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <!-- Modal Header -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 class="text-base font-semibold text-gray-900">
            投稿录制会话
            <span v-if="sessionId" class="text-gray-400 font-normal ml-1">#{{ sessionId }}</span>
          </h3>
          <button
            class="text-gray-400 hover:text-gray-600 transition-colors"
            :disabled="submitting"
            @click="emit('close')"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <!-- Modal Body -->
        <div class="px-6 py-4">
          <!-- Error Message -->
          <div
            v-if="errorMsg"
            class="mb-3 p-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600"
          >
            {{ errorMsg }}
          </div>

          <!-- Template Select -->
          <div class="mb-4">
            <label class="block text-sm font-medium text-gray-700 mb-1">选择投稿模板</label>
            <select
              v-model="selectedTemplateId"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all bg-white"
            >
              <option value="" disabled>选择模板投稿</option>
              <option v-for="t in localTemplates" :key="t.id" :value="String(t.id)">
                {{ t.name }}
              </option>
            </select>
          </div>

          <!-- Submit Button -->
          <button
            class="w-full px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="!selectedTemplateId || submitting"
            @click="handleSubmit"
          >
            <template v-if="submitting">
              <span class="inline-flex items-center gap-2">
                <span
                  class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"
                />
                投稿中...
              </span>
            </template>
            <template v-else> 提交投稿 </template>
          </button>

          <!-- Loading Hint -->
          <div v-if="submitting" class="mt-3 text-center">
            <span class="text-sm text-gray-500">正在提交投稿...请稍候</span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
