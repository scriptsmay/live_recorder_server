<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useReplayToolboxStore } from '@/stores/replay-toolbox'
import { useToast } from '@/utils/toast'
import { apiGet, ApiError } from '@/utils/api'
import type { ReplaySettings, UploadTemplate } from '@/types/api'

const route = useRoute()
const store = useReplayToolboxStore()
const toast = useToast()

const principalId = computed(() => route.params.principalId as string)

const settingsDraft = ref<ReplaySettings>({
  upload_template_id: '',
  auto_upload: 'false',
  auto_backup: 'true',
  max_count_per_run: '1',
})
const templates = ref<UploadTemplate[]>([])

onMounted(async () => {
  store.selectedPrincipalId = principalId.value
  await store.fetchSettings()
  await fetchTemplates()
})

watch(principalId, async (id) => {
  store.selectedPrincipalId = id
  await store.fetchSettings()
})

watch(
  () => store.settings,
  (settings) => {
    if (settings) settingsDraft.value = { ...settings }
  },
  { immediate: true },
)

async function fetchTemplates() {
  try {
    const res = await apiGet<UploadTemplate[]>('/api/upload_templates')
    templates.value = res.data || []
  } catch (err) {
    toast.error('加载模板失败: ' + (err instanceof ApiError ? err.message : String(err)))
  }
}

async function handleSave() {
  await store.updateSettings(settingsDraft.value)
}
</script>

<template>
  <div class="max-w-lg">
    <div class="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
      <h2 class="text-sm font-semibold text-gray-900 mb-4">主播回放配置</h2>
      <div class="space-y-4">
        <label class="block">
          <span class="text-xs text-gray-500">投稿模板</span>
          <select
            v-model="settingsDraft.upload_template_id"
            class="mt-1 w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
          >
            <option value="" disabled>选择模板投稿</option>
            <option v-for="t in templates" :key="t.id" :value="String(t.id)">
              {{ t.name }}
            </option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs text-gray-500">单次最大处理数</span>
          <input
            v-model="settingsDraft.max_count_per_run"
            type="number"
            min="1"
            class="mt-1 w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
          />
        </label>
        <label class="flex items-center justify-between text-sm text-gray-700">
          <span>自动投稿</span>
          <input
            v-model="settingsDraft.auto_upload"
            true-value="true"
            false-value="false"
            type="checkbox"
            class="w-4 h-4 accent-brand-600"
          />
        </label>
        <label class="flex items-center justify-between text-sm text-gray-700">
          <span>投稿后备份</span>
          <input
            v-model="settingsDraft.auto_backup"
            true-value="true"
            false-value="false"
            type="checkbox"
            class="w-4 h-4 accent-brand-600"
          />
        </label>
        <button
          class="w-full px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          :disabled="store.busy"
          @click="handleSave"
        >
          保存配置
        </button>
      </div>
    </div>
  </div>
</template>
