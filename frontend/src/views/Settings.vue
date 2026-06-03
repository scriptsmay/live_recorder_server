<script setup lang="ts">
/**
 * 全局设置 - 数据驱动的配置表单
 *
 * 从 settings.ejs 迁移
 * - 按分组展示设置项
 * - 每个设置项渲染为带标签的输入框
 * - 批量保存所有设置
 *
 * API:
 *   GET  /api/settings -> { status, data: SettingItem[], map: Record<string,string> }
 *   PUT  /api/settings  body: { key: value, ... } -> { status, data: SettingItem[] }
 */
import { ref, reactive, onMounted } from 'vue'
import { apiGet, apiPut, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import type { SettingItem } from '@/types/api'

const toast = useToast()

// ---- 设置分组定义 ----
const settingGroups = [
  {
    title: '录制设置',
    keys: ['recording_format', 'recording_quality', 'segment_duration', 'pool_size'],
  },
  {
    title: '投稿设置',
    keys: ['auto_upload', 'upload_delay'],
  },
  {
    title: '转码 / HLS 设置',
    keys: [
      'transcode_enabled',
      'transcode_concurrency',
      'transcode_format',
      'hls_enabled',
      'hls_segment_duration',
    ],
  },
  {
    title: '弹幕设置',
    keys: ['danmaku_enabled', 'danmaku_font_size', 'danmaku_opacity'],
  },
]

// ---- 状态 ----
const settingsMap = reactive<Record<string, string>>({})
const loading = ref(false)
const saving = ref(false)

// ---- 工具函数 ----

/**
 * 根据值的格式推断输入框类型
 * - 纯数字（含小数）-> number
 * - 其他 -> text
 */
function inputType(key: string): string {
  const val = settingsMap[key]
  if (val !== undefined && val !== '') {
    return /^\d+(\.\d+)?$/.test(val) ? 'number' : 'text'
  }
  // 值为空时，根据 key 名推断
  const numericHints = ['duration', 'size', 'concurrency', 'delay', 'font_size', 'opacity', 'pool']
  if (numericHints.some((h) => key.includes(h))) return 'number'
  return 'text'
}

/**
 * 将 key 转换为可读标签
 * recording_format -> Recording Format
 */
function labelForKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * 为 number 类型输入框提供 step 属性
 */
function inputStep(key: string): string | undefined {
  if (key.includes('opacity')) return '0.05'
  return undefined
}

// ---- 数据加载 ----
async function fetchSettings() {
  loading.value = true
  try {
    const res = await apiGet<SettingItem[]>('/api/settings')

    // 优先使用服务端返回的 map
    const serverMap = (res as unknown as { map?: Record<string, string> }).map
    if (serverMap && typeof serverMap === 'object') {
      Object.entries(serverMap).forEach(([k, v]) => {
        settingsMap[k] = v
      })
    } else if (Array.isArray(res.data)) {
      // 回退：从 rows 数组构建 map
      res.data.forEach((item: SettingItem) => {
        settingsMap[item.key] = item.value
      })
    }
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '加载设置失败')
  } finally {
    loading.value = false
  }
}

// ---- 批量保存 ----
async function saveSettings() {
  saving.value = true
  try {
    const allKeys = settingGroups.flatMap((g) => g.keys)
    const updates: Record<string, string> = {}
    for (const key of allKeys) {
      updates[key] = settingsMap[key] ?? ''
    }

    await apiPut('/api/settings', updates)
    toast.success('设置已保存')
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '保存设置失败')
  } finally {
    saving.value = false
  }
}

// ---- 生命周期 ----
onMounted(fetchSettings)
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900">全局设置</h1>
      <button
        class="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="saving || loading"
        @click="saveSettings"
      >
        {{ saving ? '保存中...' : '保存设置' }}
      </button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="text-center py-12">
      <div
        class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"
      />
      <span class="text-sm text-gray-500">加载中...</span>
    </div>

    <!-- 设置分组 -->
    <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div
        v-for="group in settingGroups"
        :key="group.title"
        class="bg-white rounded-xl border border-gray-200 shadow-sm"
      >
        <div class="px-6 py-4 border-b border-gray-200">
          <h2 class="text-lg font-semibold text-gray-900">{{ group.title }}</h2>
        </div>
        <div class="p-6 space-y-4">
          <div v-for="key in group.keys" :key="key">
            <label :for="`set_${key}`" class="block text-sm font-medium text-gray-700 mb-1">
              {{ labelForKey(key) }}
            </label>
            <input
              :id="`set_${key}`"
              v-model="settingsMap[key]"
              :type="inputType(key)"
              :step="inputStep(key)"
              class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all"
              :placeholder="key"
            />
            <p class="mt-1 text-xs text-gray-400">{{ key }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
