<script setup lang="ts">
/**
 * 全局设置 - 从 settings.ejs 完整迁移
 *
 * API:
 *   GET  /api/settings -> { status, data: SettingItem[], map: Record<string,string> }
 *   PUT  /api/settings  body: { key: value, ... }
 *
 * 设计：Linear 风格吸顶操作栏 + 左侧分组导航 + 行式设置列表。
 * 布尔项（options 为 true/false）渲染为开关，其余保持原有控件类型。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { apiGet, apiPost, apiPut, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import type { SettingItem } from '@/types/api'

const toast = useToast()

const toneMap = {
  indigo: { icon: 'text-indigo-600', wrap: 'bg-indigo-500/10' },
  rose: { icon: 'text-rose-600', wrap: 'bg-rose-500/10' },
  sky: { icon: 'text-sky-600', wrap: 'bg-sky-500/10' },
  amber: { icon: 'text-amber-600', wrap: 'bg-amber-500/10' },
  emerald: { icon: 'text-emerald-600', wrap: 'bg-emerald-500/10' },
} as const

type ToneName = keyof typeof toneMap

function groupTone(tone: ToneName) {
  return toneMap[tone]
}

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
  tone: ToneName
  icon: string
  items: SettingDef[]
}

// ---- 通知测试状态 ----
const testing = ref(false)
const testResults = ref<{ channel: string; enabled: boolean; sent?: boolean; error?: string }[]>([])

async function testNotification() {
  testing.value = true
  testResults.value = []
  try {
    const res = await apiPost<
      { channel: string; enabled: boolean; sent?: boolean; error?: string }[]
    >('/api/notify/test_webhook')
    testResults.value = res.data || []
    const anySent = testResults.value.some((r) => r.sent)
    if (anySent) {
      toast.success('测试通知已发送，请检查各渠道')
    } else {
      toast.warning('所有渠道均未发送，请检查配置')
    }
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '测试通知发送失败')
  } finally {
    testing.value = false
  }
}

function resultDot(r: { sent?: boolean; enabled: boolean }) {
  if (r.sent) return 'bg-green-500'
  if (r.enabled) return 'bg-amber-500'
  return 'bg-gray-300'
}

function resultText(r: { sent?: boolean; enabled: boolean; error?: string }) {
  if (r.sent) return '发送成功'
  if (r.enabled) return r.error ? `发送失败：${r.error}` : '已启用但发送失败'
  return '未启用'
}

function resultTextClass(r: { sent?: boolean; enabled: boolean }) {
  if (r.sent) return 'text-green-600'
  if (r.enabled) return 'text-amber-600'
  return 'text-gray-400'
}

// ---- 完整设置分组（与 settings.ejs 保持一致） ----
const settingGroups: SettingGroup[] = [
  {
    title: '系统设置',
    tone: 'indigo',
    icon: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z',
    items: [
      {
        key: 'webhook_enabled',
        label: '启用 Webhook 通知',
        desc: '启用后所有通知以统一 JSON 格式 POST 到自定义 URL，不启用默认降级使用环境变量中 MESSAGE_ 相关定义',
        type: 'select',
        options: ['false', 'true'],
      },
      {
        key: 'webhook_url',
        label: 'Webhook URL',
        desc: '自定义 Webhook POST 目标地址',
        type: 'text',
      },
    ],
  },
  {
    title: '录制设置',
    tone: 'rose',
    icon: 'm15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z',
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
        key: 'kuaishou_danmaku_enabled',
        label: '启用弹幕录制',
        desc: '是否在快手直播录制时同时采集弹幕数据',
        type: 'select',
        options: ['false', 'true'],
      },
    ],
  },
  {
    title: '上传设置',
    tone: 'sky',
    icon: 'M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z',
    items: [
      {
        key: 'max_upload_limit',
        label: '上传重试次数限制',
        desc: '每个录制会话的上传次数上限，重启服务后重置。默认 99（较大值以兼容旧用户），建议设为 2-3',
        type: 'number',
        attrs: { min: 1, max: 999 },
      },
    ],
  },
  {
    title: '转码 & HLS',
    tone: 'amber',
    icon: 'M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5',
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
    title: '文件管理',
    tone: 'emerald',
    icon: 'M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z',
    items: [
      {
        key: 'log_retention_days',
        label: '日志保留天数',
        desc: '超过此天数的日志文件会在启动时和每日清理时删除',
        type: 'number',
        attrs: { min: 1, max: 3650 },
      },
      {
        key: 'file_cleanup_enabled',
        label: '自动清理',
        desc: '启用后每日自动扫描并按保留天数清理可安全删除的文件',
        type: 'select',
        options: ['false', 'true'],
      },
      {
        key: 'file_cleanup_empty_dirs_enabled',
        label: '自动清理空目录',
        desc: '启用后每日回收录制和回放目录中的空目录，不删除视频文件',
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
const loadError = ref('')
const savedSnapshot = ref('')

// ---- 控件判定 & 开关辅助 ----
function isToggle(item: SettingDef) {
  return (
    item.type === 'select' &&
    !!item.options &&
    item.options.length === 2 &&
    item.options.every((o) => o === 'true' || o === 'false')
  )
}

function toggleValue(key: string) {
  return settingsMap[key] === 'true'
}

function setToggle(key: string, val: boolean) {
  settingsMap[key] = val ? 'true' : 'false'
}

// ---- 未保存更改检测 ----
function snapshot() {
  const snap: Record<string, string> = {}
  for (const group of settingGroups) {
    for (const item of group.items) {
      snap[item.key] = settingsMap[item.key] ?? ''
    }
  }
  return JSON.stringify(snap)
}

const dirty = computed(() => savedSnapshot.value !== '' && snapshot() !== savedSnapshot.value)

// ---- 分组导航 ----
function scrollToGroup(index: number) {
  document.getElementById(`group-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ---- 数据加载 ----
async function fetchSettings() {
  loading.value = true
  loadError.value = ''
  try {
    const res = await apiGet<SettingItem[]>('/api/settings')

    Object.keys(settingsMap).forEach((k) => delete settingsMap[k])

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
    savedSnapshot.value = snapshot()
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : '加载设置失败'
    toast.error(loadError.value)
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
    savedSnapshot.value = snapshot()
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
  <div class="pb-16">
    <!-- 吸顶操作栏 -->
    <header
      class="sticky top-14 z-30 -mx-4 mb-6 border-b border-gray-200/70 bg-surface/80 px-4 py-4 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <div>
            <h1 class="text-xl font-semibold tracking-tight text-gray-900">全局设置</h1>
            <p class="mt-0.5 text-xs text-gray-500">调整录制、转码、文件清理等运行时参数</p>
          </div>
          <Transition
            enter-active-class="transition duration-200"
            enter-from-class="opacity-0 -translate-y-1"
            leave-active-class="transition duration-150"
            leave-to-class="opacity-0"
          >
            <span
              v-if="dirty"
              class="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700"
            >
              <span class="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
              未保存更改
            </span>
          </Transition>
        </div>

        <div class="flex items-center gap-2.5">
          <button
            class="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="testing || loading || !!loadError"
            @click="testNotification"
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
                d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
              />
            </svg>
            {{ testing ? '测试中...' : '测试 Webhook' }}
          </button>
          <button
            class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            :class="dirty ? 'glow-accent' : ''"
            :disabled="saving || loading || !!loadError"
            @click="saveSettings"
          >
            <svg
              class="h-4 w-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
            {{ saving ? '保存中...' : '保存设置' }}
          </button>
        </div>
      </div>
    </header>

    <!-- 通知测试结果 -->
    <Transition
      enter-active-class="transition duration-200"
      enter-from-class="opacity-0 -translate-y-1"
      leave-active-class="transition duration-150"
      leave-to-class="opacity-0"
    >
      <div v-if="testResults.length > 0" class="mb-6 hairline-card rounded-xl p-4">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-sm font-semibold text-gray-900">通知测试结果</h3>
          <button
            class="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            @click="testResults = []"
          >
            关闭
          </button>
        </div>
        <div class="grid gap-2 sm:grid-cols-2">
          <div
            v-for="r in testResults"
            :key="r.channel"
            class="flex items-center gap-2.5 rounded-lg border border-gray-200 px-3 py-2"
          >
            <span class="h-2 w-2 shrink-0 rounded-full" :class="resultDot(r)" />
            <span class="text-sm font-medium text-gray-700">{{ r.channel }}</span>
            <span class="ml-auto text-xs" :class="resultTextClass(r)">{{ resultText(r) }}</span>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 加载中骨架 -->
    <div v-if="loading" class="grid grid-cols-1 gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
      <div class="hidden lg:block">
        <div class="hairline-card rounded-xl p-3">
          <div class="space-y-2 animate-pulse">
            <div v-for="n in 5" :key="n" class="h-9 rounded-lg bg-gray-100" />
          </div>
        </div>
      </div>
      <div class="space-y-6">
        <div v-for="n in 3" :key="n" class="hairline-card rounded-xl p-5">
          <div class="animate-pulse space-y-4">
            <div class="h-3 w-28 rounded bg-gray-200" />
            <div class="h-3 w-2/3 rounded bg-gray-100" />
            <div class="h-3 w-1/2 rounded bg-gray-100" />
          </div>
        </div>
      </div>
    </div>

    <!-- 加载失败 -->
    <div
      v-else-if="loadError"
      class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      <div class="flex items-center justify-between gap-3">
        <span>{{ loadError }}</span>
        <button
          class="px-3 py-1 text-xs font-medium rounded-lg border border-red-200 text-red-700 hover:bg-red-100 transition-colors"
          @click="fetchSettings"
        >
          重试
        </button>
      </div>
    </div>

    <!-- 主体 -->
    <div v-else class="grid grid-cols-1 gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
      <!-- 分组导航 -->
      <aside class="hidden lg:block">
        <nav class="sticky top-36 hairline-card rounded-xl p-2">
          <button
            v-for="(group, gi) in settingGroups"
            :key="group.title"
            class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
            @click="scrollToGroup(gi)"
          >
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
              :class="groupTone(group.tone).wrap"
            >
              <svg
                class="h-3.5 w-3.5"
                :class="groupTone(group.tone).icon"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" :d="group.icon" />
              </svg>
            </span>
            <span class="truncate">{{ group.title }}</span>
          </button>
        </nav>
      </aside>

      <!-- 设置分组 -->
      <div class="space-y-6">
        <section
          v-for="(group, gi) in settingGroups"
          :id="`group-${gi}`"
          :key="group.title"
          class="scroll-mt-36 overflow-hidden rounded-xl hairline-card shimmer-sweep"
        >
          <div class="flex items-center gap-3 border-b border-gray-200/70 px-5 py-3.5">
            <span
              class="flex h-8 w-8 items-center justify-center rounded-lg"
              :class="groupTone(group.tone).wrap"
            >
              <svg
                class="h-4 w-4"
                :class="groupTone(group.tone).icon"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" :d="group.icon" />
              </svg>
            </span>
            <div>
              <h2 class="text-sm font-semibold text-gray-900">{{ group.title }}</h2>
              <p class="text-xs text-gray-400">{{ group.items.length }} 项配置</p>
            </div>
          </div>

          <div class="divide-y divide-gray-100 px-5">
            <div
              v-for="item in group.items"
              :key="item.key"
              class="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
            >
              <div class="min-w-0 sm:max-w-[60%]">
                <label :for="`set_${item.key}`" class="block text-sm font-medium text-gray-800">
                  {{ item.label }}
                </label>
                <p class="mt-1 text-xs leading-relaxed text-gray-400">{{ item.desc }}</p>
              </div>

              <div class="w-full shrink-0 sm:w-[220px]">
                <!-- 开关 -->
                <div v-if="isToggle(item)" class="flex sm:justify-end">
                  <button
                    type="button"
                    role="switch"
                    :aria-checked="toggleValue(item.key)"
                    :aria-label="item.label"
                    class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200"
                    :class="
                      toggleValue(item.key)
                        ? 'bg-brand-600 shadow-[0_0_14px_-2px_var(--color-brand-500)]'
                        : 'bg-gray-300'
                    "
                    @click="setToggle(item.key, !toggleValue(item.key))"
                  >
                    <span
                      class="inline-block h-5 w-5 transform rounded-full bg-[#ffffff] shadow-sm transition-transform duration-200"
                      :class="toggleValue(item.key) ? 'translate-x-[22px]' : 'translate-x-0.5'"
                    />
                  </button>
                </div>

                <!-- 下拉 -->
                <select
                  v-else-if="item.type === 'select'"
                  :id="`set_${item.key}`"
                  v-model="settingsMap[item.key]"
                  class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-all focus:border-brand-500 focus:ring-2 focus:ring-brand-500/60"
                >
                  <option v-for="opt in item.options" :key="opt" :value="opt">
                    {{ opt || '(自动)' }}
                  </option>
                </select>

                <!-- 文本 / 数字 -->
                <input
                  v-else
                  :id="`set_${item.key}`"
                  v-model="settingsMap[item.key]"
                  :type="item.type"
                  v-bind="item.attrs || {}"
                  class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-all focus:border-brand-500 focus:ring-2 focus:ring-brand-500/60"
                  :placeholder="item.label"
                />
              </div>
            </div>
          </div>
        </section>

        <!-- 底部保存 -->
        <div class="flex items-center justify-end gap-3">
          <span v-if="dirty" class="text-xs text-amber-600">有未保存的更改</span>
          <button
            class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            :class="dirty ? 'glow-accent' : ''"
            :disabled="saving || loading"
            @click="saveSettings"
          >
            {{ saving ? '保存中...' : '保存设置' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
