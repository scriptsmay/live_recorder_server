<script setup lang="ts">
/**
 * 全局设置 - 从 settings.ejs 完整迁移
 *
 * API:
 *   GET  /api/settings -> { status, data: SettingItem[], map: Record<string,string> }
 *   PUT  /api/settings  body: { key: value, ... }
 */
import { reactive, ref, onMounted } from 'vue'
import { apiGet, apiPut, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import type { SettingItem } from '@/types/api'

const toast = useToast()

// ---- 设置项类型定义 ----
interface SettingDef {
  key: string
  label: string
  desc: string
  type: 'text' | 'number' | 'select'
  options?: string[]
  attrs?: Record<string, string | number>
}

interface SettingGroup {
  title: string
  items: SettingDef[]
}

// ---- 完整设置分组（与 settings.ejs 保持一致） ----
const settingGroups: SettingGroup[] = [
  {
    title: '录制设置',
    items: [
      {
        key: 'downloader',
        label: '下载插件',
        desc: '选择录制的下载引擎',
        type: 'select',
        options: ['ffmpeg'],
      },
      {
        key: 'pool_size',
        label: '下载线程池大小',
        desc: '限制最大同时录制数',
        type: 'number',
        attrs: { min: 1, max: 20 },
      },
      {
        key: 'watchdog_interval',
        label: '录制状态检查间隔（秒）',
        desc: '看门狗检查周期',
        type: 'number',
        attrs: { min: 10, max: 600 },
      },
      {
        key: 'watchdog_timeout',
        label: '录制状态检查超时（秒）',
        desc: '超过此时长无活动则标记为完成',
        type: 'number',
        attrs: { min: 10, max: 3600 },
      },
      {
        key: 'filtering_threshold',
        label: '碎片过滤（MB）',
        desc: '小于此大小的视频文件将被过滤删除',
        type: 'number',
        attrs: { min: 0, step: 1 },
      },
      {
        key: 'delay',
        label: '下播延迟检测（秒）',
        desc: '检测到主播下播后延迟确认时间',
        type: 'number',
        attrs: { min: 0, max: 3600 },
      },
      {
        key: 'max_resume_retries',
        label: '会话恢复重试次数',
        desc: '服务器启动时自动恢复录制会话的最大重试次数，默认 3',
        type: 'number',
        attrs: { min: 0, max: 20 },
      },
    ],
  },
  {
    title: '上传设置',
    items: [
      {
        key: 'submit_api',
        label: '提交接口',
        desc: 'biliup --submit 选项，留空为自动选择',
        type: 'select',
        options: ['', 'app', 'web', 'b-cut-android'],
      },
      {
        key: 'lines',
        label: '上传线路',
        desc: 'b站上传线路选择，留空为自动',
        type: 'select',
        options: ['', 'bda', 'bda2', 'ws', 'qn', 'bldsa', 'tx', 'txa'],
      },
      {
        key: 'threads',
        label: '上传并发',
        desc: '单文件并发上传数',
        type: 'number',
        attrs: { min: 1, max: 16 },
      },
      {
        key: 'pool2_size',
        label: '上传线程池大小',
        desc: '负责上传事件的线程池大小',
        type: 'number',
        attrs: { min: 1, max: 20 },
      },
      {
        key: 'max_upload_limit',
        label: '上传重试次数限制',
        desc: '每个录制会话的上传次数上限，重启服务后重置。默认99（较大值以兼容旧用户），建议设为2-3',
        type: 'number',
        attrs: { min: 1, max: 999 },
      },
    ],
  },
  {
    title: '转码 & HLS',
    items: [
      {
        key: 'auto_transcode',
        label: '自动转码',
        desc: '录制完成后自动将 FLV/TS 转换为 MP4',
        type: 'select',
        options: ['true', 'false'],
      },
      {
        key: 'transcode_delete_originals',
        label: '转码后删除原始文件',
        desc: '转码成功后自动删除 FLV/TS 原始文件',
        type: 'select',
        options: ['true', 'false'],
      },
      {
        key: 'transcode_concurrency',
        label: '转码并发数',
        desc: '转码队列的最大并发数',
        type: 'number',
        attrs: { min: 1, max: 10 },
      },
      {
        key: 'auto_generate_hls',
        label: '自动生成 HLS',
        desc: '转码完成后自动生成 HLS 索引（推荐开启，零重编码，速度极快）',
        type: 'select',
        options: ['true', 'false'],
      },
      {
        key: 'hls_segment_duration',
        label: 'HLS 分段时长（秒）',
        desc: '每个 HLS 分段的时间长度，默认 10 秒',
        type: 'number',
        attrs: { min: 5, max: 60 },
      },
      {
        key: 'hls_cleanup_days',
        label: 'HLS 清理天数',
        desc: '超过此天数的 HLS 文件将被自动清理，设为 0 则不清理',
        type: 'number',
        attrs: { min: 0, max: 365 },
      },
    ],
  },
  {
    title: '弹幕设置',
    items: [
      {
        key: 'kuaishou_danmaku_enabled',
        label: '启用弹幕录制',
        desc: '是否在快手直播录制时同时采集弹幕数据',
        type: 'select',
        options: ['false', 'true'],
      },
      {
        key: 'danmaku_burn_concurrency',
        label: '弹幕压制并发',
        desc: '弹幕压制队列最大并发数，8G内存NAS建议固定为 1',
        type: 'number',
        attrs: { min: 1, max: 1 },
      },
      {
        key: 'danmaku_density_per_second',
        label: '每秒弹幕上限',
        desc: 'ASS 生成时每秒最多渲染的弹幕数，超出部分丢弃',
        type: 'number',
        attrs: { min: 5, max: 100 },
      },
      {
        key: 'danmaku_font_family',
        label: '弹幕字体',
        desc: 'ASS 渲染使用的字体名称',
        type: 'select',
        options: ['Noto Sans CJK SC', 'Noto Sans CJK SC Medium', 'Source Han Sans SC Medium'],
      },
      {
        key: 'danmaku_font_size',
        label: '弹幕字号（1080p）',
        desc: '1080p 分辨率下的默认字号',
        type: 'number',
        attrs: { min: 16, max: 64 },
      },
      {
        key: 'danmaku_opacity',
        label: '弹幕不透明度',
        desc: '0-1 之间，0 完全透明，1 完全不透明',
        type: 'number',
        attrs: { min: 0, max: 1, step: 0.05 },
      },
      {
        key: 'danmaku_outline_colour',
        label: '描边颜色',
        desc: '6 位 RGB 十六进制，如 000000（黑）、FFFFFF（白）',
        type: 'text',
        attrs: { maxlength: 6, pattern: '[0-9A-Fa-f]{6}' },
      },
      {
        key: 'danmaku_outline_width',
        label: '描边宽度',
        desc: '描边像素宽度，0 为无描边',
        type: 'number',
        attrs: { min: 0, max: 5 },
      },
    ],
  },
  {
    title: '日志设置',
    items: [
      {
        key: 'log_retention_days',
        label: '日志保留天数',
        desc: '超过此天数的日志文件会在启动时和每日清理时删除',
        type: 'number',
        attrs: { min: 1, max: 3650 },
      },
    ],
  },
  {
    title: '文件管理',
    items: [
      {
        key: 'file_cleanup_enabled',
        label: '自动清理',
        desc: '启用后每日自动扫描并按保留天数清理可安全删除的文件',
        type: 'select',
        options: ['false', 'true'],
      },
      {
        key: 'file_cleanup_retention_days',
        label: '保留天数',
        desc: '超过此天数且可安全删除的文件将被自动清理',
        type: 'number',
        attrs: { min: 1, max: 365 },
      },
      {
        key: 'file_cleanup_categories',
        label: '清理分类',
        desc: '留空清理全部；可填 recording,replay,danmaku 逗号分隔',
        type: 'text',
      },
      {
        key: 'file_cleanup_watermark_warn',
        label: '水位警告阈值（%）',
        desc: '磁盘占用超过此百分比时发送警告通知',
        type: 'number',
        attrs: { min: 50, max: 99 },
      },
      {
        key: 'file_cleanup_watermark_critical',
        label: '水位紧急阈值（%）',
        desc: '磁盘占用超过此百分比时发送紧急通知',
        type: 'number',
        attrs: { min: 60, max: 99 },
      },
      {
        key: 'file_cleanup_suggestion_notify',
        label: '启用清理通知',
        desc: '启用后发送通知，提示清理可安全删除的文件',
        type: 'select',
        options: ['false', 'true'],
      },
    ],
  },
]

// ---- 状态 ----
const settingsMap = reactive<Record<string, string>>({})
const loading = ref(false)
const saving = ref(false)

// ---- 数据加载 ----
async function fetchSettings() {
  loading.value = true
  try {
    const res = await apiGet<SettingItem[]>('/api/settings')

    const serverMap = (res as unknown as { map?: Record<string, string> }).map
    if (serverMap && typeof serverMap === 'object') {
      Object.entries(serverMap).forEach(([k, v]) => {
        settingsMap[k] = v
      })
    } else if (Array.isArray(res.data)) {
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
    const allKeys = settingGroups.flatMap((g) => g.items.map((i) => i.key))
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
        <div class="px-4 py-2 border-b border-gray-200">
          <h2 class="text-md font-semibold text-gray-900">{{ group.title }}</h2>
        </div>
        <div class="p-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            <div v-for="item in group.items" :key="item.key">
              <label :for="`set_${item.key}`" class="block text-sm font-medium text-gray-700 mb-1">
                {{ item.label }}
              </label>

              <!-- select 下拉 -->
              <select
                v-if="item.type === 'select'"
                :id="`set_${item.key}`"
                v-model="settingsMap[item.key]"
                class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all bg-white"
              >
                <option v-for="opt in item.options" :key="opt" :value="opt">
                  {{ opt || '(自动)' }}
                </option>
              </select>

              <!-- 普通输入 -->
              <input
                v-else
                :id="`set_${item.key}`"
                v-model="settingsMap[item.key]"
                :type="item.type"
                v-bind="item.attrs || {}"
                class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition-all"
                :placeholder="item.label"
              />

              <p class="mt-1 text-xs text-gray-400">{{ item.desc }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="flex items-center justify-between mt-6">
      <h1 class="text-2xl font-bold text-gray-900"></h1>
      <button
        class="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="saving || loading"
        @click="saveSettings"
      >
        {{ saving ? '保存中...' : '保存设置' }}
      </button>
    </div>
  </div>
</template>
