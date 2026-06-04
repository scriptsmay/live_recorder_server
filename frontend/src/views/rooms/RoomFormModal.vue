<script setup lang="ts">
/**
 * 直播间表单弹窗 - 新增 / 编辑
 *
 * - Teleport 到 body
 * - 录制/暂停中 limited 模式：仅可修改通知开关与投稿模板
 * - 轮询间隔条件显示
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

const form = reactive<RoomFormData & { room_url: string }>({
  room_url: '',
  room_name: '',
  filename_template: '',
  segment_duration: 0,
  notification_enabled: true,
  monitoring_enabled: true,
  upload_template_id: null,
  polling_enabled: false,
  polling_interval: 60,
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
  form.polling_interval = 60
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
        form.polling_interval = r.polling_interval || 60
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
          polling_interval: form.polling_enabled ? form.polling_interval : 60,
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
        class="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
        @click="onOverlayClick"
      >
        <div class="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
          <!-- 头部 -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <h3 class="text-lg font-semibold text-gray-900">
              {{ limited ? '编辑（录制中）' : editId ? '编辑直播间' : '新增直播间' }}
            </h3>
            <button
              class="text-gray-400 hover:text-gray-600 transition-colors"
              @click="emit('close')"
            >
              <svg
                class="w-5 h-5"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- 表单 -->
          <div class="px-6 py-5 space-y-5">
            <!-- 有限编辑提示 -->
            <div
              v-if="limited"
              class="flex items-start gap-2 rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-700"
            >
              <svg
                class="w-5 h-5 flex-shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
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
              <label class="block text-sm font-medium text-gray-700 mb-1" for="room-url">
                直播间地址 <span class="text-red-500">*</span>
              </label>
              <input
                id="room-url"
                v-model="form.room_url"
                type="text"
                class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 disabled:bg-gray-100 disabled:text-gray-500"
                placeholder="https://live.example.com/room"
                :disabled="!!editId"
              />
            </div>

            <!-- 两列布局 -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <!-- 直播间名称 -->
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1" for="room-name"
                  >直播间名称</label
                >
                <input
                  id="room-name"
                  v-model="form.room_name"
                  type="text"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 disabled:bg-gray-100 disabled:text-gray-500"
                  placeholder="主播名"
                  :disabled="limited"
                />
              </div>

              <!-- 文件名模板 -->
              <div v-if="!limited">
                <label class="block text-sm font-medium text-gray-700 mb-1" for="filename-template">
                  文件名模板
                  <span class="text-gray-400 font-normal"
                    >(默认
                    <code class="text-xs bg-gray-100 px-1 rounded">{room_name}_{datetime}</code
                    >)</span
                  >
                </label>
                <input
                  id="filename-template"
                  v-model="form.filename_template"
                  type="text"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  placeholder="{room_name}_{datetime}"
                />
                <p class="text-xs text-gray-400 mt-1">
                  支持 <code class="bg-gray-100 px-0.5 rounded">{room_name}</code>
                  <code class="bg-gray-100 px-0.5 rounded">{datetime}</code>
                  <code class="bg-gray-100 px-0.5 rounded">{YYYY}</code>
                  <code class="bg-gray-100 px-0.5 rounded">{MM}</code>
                  <code class="bg-gray-100 px-0.5 rounded">{DD}</code>
                  <code class="bg-gray-100 px-0.5 rounded">{HH}</code>
                  <code class="bg-gray-100 px-0.5 rounded">{mm}</code>
                  <code class="bg-gray-100 px-0.5 rounded">{ss}</code>
                </p>
              </div>
            </div>

            <div v-if="!limited" class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <!-- 分段时长 -->
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1" for="segment-duration"
                  >分段录制时长（秒，0 = 不分段）</label
                >
                <input
                  id="segment-duration"
                  v-model.number="form.segment_duration"
                  type="number"
                  min="0"
                  step="60"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                />
                <p class="text-xs text-gray-400 mt-1">3600 = 每 1 小时自动分割</p>
              </div>

              <!-- 投稿模板 -->
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1" for="upload-template"
                  >投稿模板</label
                >
                <select
                  id="upload-template"
                  v-model="form.upload_template_id"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white"
                >
                  <option :value="null">不使用模板</option>
                  <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
                </select>
                <p class="text-xs text-gray-400 mt-1">录制完成且转码就绪时自动投稿</p>
              </div>
            </div>

            <!-- 投稿模板（limited 模式下也要展示） -->
            <div v-if="limited">
              <label class="block text-sm font-medium text-gray-700 mb-1" for="upload-template"
                >投稿模板</label
              >
              <select
                id="upload-template"
                v-model="form.upload_template_id"
                class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 bg-white"
              >
                <option :value="null">不使用模板</option>
                <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
              </select>
              <p class="text-xs text-gray-400 mt-1">录制完成且转码就绪时自动投稿</p>
            </div>

            <!-- 开关行 -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
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
                description="收到api请求后启动 ffmpeg 录制"
              />
            </div>

            <!-- 轮询设置 -->
            <div v-if="!limited" class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <SwitchField
                  v-model="form.polling_enabled"
                  label="启用轮询"
                  description="定期查询开播状态"
                />
              </div>

              <div v-if="form.polling_enabled">
                <label class="block text-sm font-medium text-gray-700 mb-1" for="polling-interval"
                  >轮询间隔（秒）</label
                >
                <input
                  id="polling-interval"
                  v-model.number="form.polling_interval"
                  type="number"
                  min="30"
                  max="3600"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                />
                <p class="text-xs text-gray-400 mt-1">建议不少于 30 秒</p>
              </div>
            </div>
          </div>

          <!-- 底部 -->
          <div class="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
            <button
              class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              @click="emit('close')"
            >
              取消
            </button>
            <button
              class="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="saving"
              @click="handleSave"
            >
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
