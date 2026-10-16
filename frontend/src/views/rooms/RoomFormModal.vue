<script setup lang="ts">
/**
 * 直播间表单弹窗 - 新增 / 编辑
 *
 * - Teleport 到 body
 * - 录制/暂停中 limited 模式：仅可修改通知开关与投稿模板
 * - 轮询间隔条件显示
 *
 * 设计：与 Rooms.vue 保持 Linear Aesthetic —— 玻璃遮罩 + 超细描边 + 统一控件态。
 */
import { ref, reactive, watch } from 'vue'
import { apiGet, apiPost, apiPut, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import SwitchField from '@/components/SwitchField.vue'
import type { Room, RoomFormData, UploadTemplate } from '@/types/api'

const props = defineProps<{
  visible: boolean
  editId: number | null
  limited: boolean
  templates: UploadTemplate[]
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const toast = useToast()
const saving = ref(false)

const DEFAULT_POLLING_INTERVAL = 90

const fieldClass =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-all focus:border-brand-500 focus:ring-2 focus:ring-brand-500/60 disabled:bg-gray-100 disabled:text-gray-500'

const form = reactive<RoomFormData & { room_url: string }>({
  room_url: '',
  room_name: '',
  filename_template: '',
  segment_duration: 0,
  notification_enabled: true,
  monitoring_enabled: true,
  upload_template_id: null,
  polling_enabled: false,
  polling_interval: DEFAULT_POLLING_INTERVAL,
})

function resetForm() {
  form.room_url = ''
  form.room_name = ''
  form.filename_template = ''
  form.segment_duration = 0
  form.notification_enabled = true
  form.monitoring_enabled = true
  form.upload_template_id = null
  form.polling_enabled = false
  form.polling_interval = DEFAULT_POLLING_INTERVAL
}

// 打开弹窗时加载数据
watch(
  () => props.visible,
  async (val) => {
    if (!val) return
    resetForm()
    if (props.editId) {
      try {
        const res = await apiGet<Room>(`/api/rooms/${props.editId}`)
        const r = res.data
        form.room_url = r.room_url
        form.room_name = r.room_name || ''
        form.filename_template = r.filename_template || ''
        form.segment_duration = r.segment_duration || 0
        form.notification_enabled = r.notification_enabled !== false
        form.monitoring_enabled = r.monitoring_enabled !== false
        form.upload_template_id = r.upload_template_id ?? null
        form.polling_enabled = r.polling_enabled === true
        form.polling_interval = r.polling_interval || DEFAULT_POLLING_INTERVAL
      } catch (err) {
        toast.error('加载直播间失败: ' + (err instanceof ApiError ? err.message : '未知错误'))
        emit('close')
      }
    }
  },
)

async function handleSave() {
  if (!props.editId && !form.room_url.trim()) {
    toast.warning('直播间地址必填')
    return
  }

  saving.value = true
  try {
    const body = props.limited
      ? {
          notification_enabled: form.notification_enabled,
          upload_template_id: form.upload_template_id,
        }
      : {
          room_name: form.room_name,
          filename_template: form.filename_template || undefined,
          segment_duration: form.segment_duration,
          notification_enabled: form.notification_enabled,
          monitoring_enabled: form.monitoring_enabled,
          upload_template_id: form.upload_template_id,
          polling_enabled: form.polling_enabled,
          polling_interval: form.polling_enabled ? form.polling_interval : DEFAULT_POLLING_INTERVAL,
        }

    if (props.editId) {
      await apiPut(`/api/rooms/${props.editId}`, body)
      toast.success('更新成功')
    } else {
      await apiPost('/api/rooms', { room_url: form.room_url.trim(), ...body })
      toast.success('创建成功')
    }
    emit('saved')
  } catch (err) {
    toast.error('保存失败: ' + (err instanceof ApiError ? err.message : '未知错误'))
  } finally {
    saving.value = false
  }
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains('modal-overlay')) {
    emit('close')
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="visible"
        class="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm"
        @click="onOverlayClick"
      >
        <div
          class="hairline-card max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl shadow-2xl"
        >
          <!-- 头部 -->
          <div
            class="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200/70 bg-surface/85 px-6 py-4 backdrop-blur-xl"
          >
            <div class="flex items-center gap-3">
              <span
                class="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-brand-500/10 text-brand-600"
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
                    d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
                  />
                </svg>
              </span>
              <div>
                <h3 class="text-base font-semibold tracking-tight text-gray-900">
                  {{ limited ? '编辑（录制中）' : editId ? '编辑直播间' : '新增直播间' }}
                </h3>
                <p class="mt-0.5 text-xs text-gray-400">
                  {{
                    limited
                      ? '录制进行中，仅可调整通知与投稿模板'
                      : '配置直播间地址、录制参数与轮询'
                  }}
                </p>
              </div>
            </div>
            <button
              class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
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

          <!-- 表单 -->
          <div class="space-y-5 px-6 py-5">
            <!-- 有限编辑提示 -->
            <div
              v-if="limited"
              class="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-700"
            >
              <svg
                class="mt-0.5 h-5 w-5 shrink-0"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"
                />
              </svg>
              <span>录制或暂停中，仅可修改通知开关与投稿模板。</span>
            </div>

            <!-- 直播间地址 -->
            <div>
              <label class="mb-1.5 block text-sm font-medium text-gray-700" for="room-url">
                直播间地址 <span class="text-red-500">*</span>
              </label>
              <input
                id="room-url"
                v-model="form.room_url"
                type="text"
                :class="fieldClass"
                placeholder="https://live.example.com/room"
                :disabled="!!editId"
              />
            </div>

            <!-- 两列布局 -->
            <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
              <!-- 直播间名称 -->
              <div>
                <label class="mb-1.5 block text-sm font-medium text-gray-700" for="room-name"
                  >直播间名称</label
                >
                <input
                  id="room-name"
                  v-model="form.room_name"
                  type="text"
                  :class="fieldClass"
                  placeholder="主播名"
                  :disabled="limited"
                />
              </div>

              <!-- 文件名模板 -->
              <div v-if="!limited">
                <label
                  class="mb-1.5 block text-sm font-medium text-gray-700"
                  for="filename-template"
                >
                  文件名模板
                  <span class="font-normal text-gray-400"
                    >(默认 <code class="text-xs">{room_name}_{datetime}</code>)</span
                  >
                </label>
                <input
                  id="filename-template"
                  v-model="form.filename_template"
                  type="text"
                  :class="[fieldClass, 'font-mono']"
                  placeholder="{room_name}_{datetime}"
                />
                <p class="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-gray-400">
                  <span>支持</span>
                  <code>{room_name}</code>
                  <code>{datetime}</code>
                  <code>{YYYY}</code>
                  <code>{MM}</code>
                  <code>{DD}</code>
                  <code>{HH}</code>
                  <code>{mm}</code>
                  <code>{ss}</code>
                </p>
              </div>
            </div>

            <div v-if="!limited" class="grid grid-cols-1 gap-5 md:grid-cols-2">
              <!-- 分段时长 -->
              <div>
                <label class="mb-1.5 block text-sm font-medium text-gray-700" for="segment-duration"
                  >分段录制时长（秒，0 = 不分段）</label
                >
                <input
                  id="segment-duration"
                  v-model.number="form.segment_duration"
                  type="number"
                  min="0"
                  step="60"
                  :class="fieldClass"
                />
                <p class="mt-1.5 text-xs text-gray-400">3600 = 每 1 小时自动分割</p>
              </div>

              <!-- 投稿模板 -->
              <div>
                <label class="mb-1.5 block text-sm font-medium text-gray-700" for="upload-template"
                  >投稿模板</label
                >
                <select id="upload-template" v-model="form.upload_template_id" :class="fieldClass">
                  <option :value="null">不使用模板</option>
                  <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
                </select>
                <p class="mt-1.5 text-xs text-gray-400">录制完成且转码就绪时自动投稿</p>
              </div>
            </div>

            <!-- 投稿模板（limited 模式下也要展示） -->
            <div v-if="limited">
              <label class="mb-1.5 block text-sm font-medium text-gray-700" for="upload-template"
                >投稿模板</label
              >
              <select id="upload-template" v-model="form.upload_template_id" :class="fieldClass">
                <option :value="null">不使用模板</option>
                <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
              </select>
              <p class="mt-1.5 text-xs text-gray-400">录制完成且转码就绪时自动投稿</p>
            </div>

            <!-- 开关行 -->
            <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
              <!-- 通知开关 -->
              <SwitchField
                v-model="form.notification_enabled"
                label="启用通知"
                description="录制/投稿/备份时发送通知"
              />

              <!-- 监听开关 -->
              <SwitchField
                v-if="!limited"
                v-model="form.monitoring_enabled"
                label="启用监听"
                description="收到 api 请求后启动 ffmpeg 录制"
              />
            </div>

            <!-- 轮询设置 -->
            <div v-if="!limited" class="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div>
                <SwitchField
                  v-model="form.polling_enabled"
                  label="启用轮询"
                  description="定期查询开播状态"
                />
              </div>

              <div v-if="form.polling_enabled">
                <label class="mb-1.5 block text-sm font-medium text-gray-700" for="polling-interval"
                  >轮询间隔（秒）</label
                >
                <input
                  id="polling-interval"
                  v-model.number="form.polling_interval"
                  type="number"
                  min="30"
                  max="3600"
                  :class="fieldClass"
                />
                <p class="mt-1.5 text-xs text-gray-400">建议不少于 30 秒</p>
              </div>
            </div>
          </div>

          <!-- 底部 -->
          <div
            class="sticky bottom-0 flex items-center justify-end gap-3 border-t border-gray-200/70 bg-surface/85 px-6 py-4 backdrop-blur-xl"
          >
            <button
              class="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
              @click="emit('close')"
            >
              取消
            </button>
            <button
              class="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="saving"
              @click="handleSave"
            >
              <svg v-if="saving" class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
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
              {{ saving ? '保存中...' : '保存' }}
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
