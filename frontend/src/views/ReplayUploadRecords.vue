<script setup lang="ts">
/**
 * 回放投稿记录 - 查看回放（快手回放链路）投稿历史
 *
 * v1.11.2 新增：本页只服务 `replay_upload_records` 单表，走 `/api/replay_upload_records*`。
 * 与「录制投稿记录」页（`UploadRecords.vue` / `upload_records`）彻底分表——两表 id 各自独立自增，
 * 按路径分表后本页的删除/重试不可能命中常规投稿的同号记录。
 *
 * 回放工具箱内的主播维度投稿列表是另一回事（`/api/replay/principals/:id/uploads`），保留现状。
 */
import { ref, onMounted } from 'vue'
import { apiGet, apiPost, apiDelete, ApiError } from '@/utils/api'
import { formatTime } from '@/utils/lib'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'
import Pagination from '@/components/Pagination.vue'
import Modal from '@/components/Modal.vue'
import type { ReplayUploadRecord, SeasonStatus } from '@/types/api'

const toast = useToast()
const { confirm } = useConfirm()

// ---- 筛选状态 ----
const statusFilter = ref<'all' | string>('all')
const seasonFilter = ref<'all' | SeasonStatus>('all')
const titleInput = ref('')
const titleFilter = ref('')

// ---- 列表状态 ----
const records = ref<ReplayUploadRecord[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const pageSize = 10

// ---- 合集重试状态 ----
const retryingIds = ref(new Set<number>())

// ---- 详情弹窗 ----
const detailVisible = ref(false)
const detailRecord = ref<ReplayUploadRecord | null>(null)

// ---- 文件列表弹窗 ----
const filesVisible = ref(false)
const filesRecord = ref<ReplayUploadRecord | null>(null)
const filesContent = ref<string[]>([])

// ---- 工具函数 ----

interface Badge {
  text: string
  cls: string
}

function statusBadge(status: string): Badge {
  switch (status) {
    case 'success':
      return { text: '成功', cls: 'bg-green-100 text-green-700' }
    case 'failed':
      return { text: '失败', cls: 'bg-red-100 text-red-700' }
    case 'uploading':
      return { text: '上传中', cls: 'bg-blue-100 text-blue-700' }
    case 'pending':
      return { text: '等待', cls: 'bg-gray-100 text-gray-600' }
    default:
      return { text: status || '-', cls: 'bg-gray-100 text-gray-600' }
  }
}

function getLogsPath(record: ReplayUploadRecord) {
  return `/logs?file=${encodeURIComponent('biliup_replay_' + record.id + '.log')}`
}

const STATUS_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'uploading', label: '上传中' },
] as const

const SEASON_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'none', label: '未配置' },
  { value: 'pending', label: '加入中' },
  { value: 'added', label: '已加入' },
  { value: 'failed', label: '加入失败' },
] as const

function seasonBadge(status: SeasonStatus): Badge {
  switch (status) {
    case 'pending':
      return { text: '加入中', cls: 'bg-blue-100 text-blue-700' }
    case 'added':
      return { text: '已加入', cls: 'bg-green-100 text-green-700' }
    case 'failed':
      return { text: '加入失败', cls: 'bg-red-100 text-red-700' }
    case 'skipped':
      return { text: '已跳过', cls: 'bg-amber-100 text-amber-700' }
    default:
      return { text: '未配置', cls: 'bg-gray-100 text-gray-500' }
  }
}

function canRetry(record: ReplayUploadRecord) {
  return !!record.bv_id && (record.season_status === 'none' || record.season_status === 'failed')
}

/**
 * 确认框正文：合集名来自模板（列表联表带出），模板没存名字时退回 season_id 数字。
 * 模板的合集配置是重试时的实时入参，这里显示的就是即将提交的目标。
 */
function retryConfirmMessage(record: ReplayUploadRecord) {
  const target = record.season_title?.trim() || `合集 ${record.season_id ?? '未配置'}`
  return `确定将「${record.title}」加入合集「${target}」吗？\n将按投稿模板当前的合集配置提交，结果稍后刷新查看。`
}

/** season_error 形如 `CODE: 详情`，把已知错误码翻译成可操作提示 */
const SEASON_ERROR_HINTS: Record<string, string> = {
  AUTH_EXPIRED: '登录态已失效，请在容器内重新 biliup login 后重试',
  INVALID_ARGUMENT: '请求参数不合法，请检查模板里的合集与小节配置',
  CREDENTIAL_INVALID: 'cookie 缺少必要字段，请检查账号登记的 cookie 文件',
  CSRF_FAILED: 'csrf 校验失败，通常是 cookie 已失效，请重新 biliup login',
  SECTION_INVALID: '合集小节不存在或不属于该账号，请在投稿模板里重新选择合集',
  RATE_LIMITED: '触发 B 站风控，请稍后重试',
  TOO_FREQUENT: '操作过于频繁，请稍后重试',
  VIDEO_NOT_READY: '稿件尚未转码完成，请稍后重试',
  SEASON_TIMEOUT: 'B 站接口超时，请稍后重试',
  NETWORK_ERROR: '网络异常，请稍后重试',
  HTTP_ERROR: 'B 站接口返回异常状态码，请稍后重试',
  RESPONSE_MALFORMED: 'B 站接口返回格式异常，可能是接口变更',
  BIZ_ERROR: 'B 站业务侧拒绝，请稍后重试或到合集页确认',
  ALREADY_IN_SEASON: '稿件已在合集中，无需重复加入',
  COOKIE_NOT_CONFIGURED: '模板未配置 cookie 路径，请在投稿模板里选择 biliup 账号',
  COOKIE_PATH_INVALID: 'cookie 路径不在 biliup 工作目录白名单内，请重新登记账号',
  COOKIE_NOT_FOUND: 'cookie 文件不存在，请确认容器内路径或重新 biliup login',
  COOKIE_UNREADABLE: 'cookie 文件读不了，请检查文件权限（建议 600）',
  COOKIE_MALFORMED: 'cookie 文件不是合法 JSON，请在容器内重新 biliup login',
  COOKIE_NO_CSRF: 'cookie 缺少 bili_jct，登录态不完整，请重新 biliup login',
  COOKIE_INVALID: 'cookie 加载失败，请检查账号登记与文件内容',
}

const SEASON_ERROR_FALLBACK_HINT = '加入合集失败，可手动重试；持续失败请查看服务端日志'

function seasonTooltip(record: ReplayUploadRecord) {
  if (record.season_status === 'failed' && record.season_error) {
    const code = record.season_error.split(':', 1)[0].trim()
    return `${record.season_error}\n${SEASON_ERROR_HINTS[code] || SEASON_ERROR_FALLBACK_HINT}`
  }
  if (record.season_status === 'added') return `加入时间：${formatTime(record.season_added_at)}`
  if (record.season_status === 'pending') return '正在加入合集，稍后刷新查看结果'
  if (record.season_status === 'skipped') return record.season_error || '本次未自动加入合集'
  return record.bv_id ? '未自动加入，可手动重试' : '投稿未成功，无法加入合集'
}

// ---- 数据加载 ----
async function fetchRecords() {
  loading.value = true
  try {
    const params = new URLSearchParams({
      limit: String(pageSize),
      page: String(page.value),
    })
    if (statusFilter.value !== 'all') params.set('status', statusFilter.value)
    if (seasonFilter.value !== 'all') params.set('season_status', seasonFilter.value)
    if (titleFilter.value) params.set('title', titleFilter.value)
    const res = await apiGet<ReplayUploadRecord[]>(`/api/replay_upload_records?${params}`)
    records.value = res.data
    total.value = res.total ?? 0
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '加载回放投稿记录失败')
  } finally {
    loading.value = false
  }
}

function handlePageChange(p: number) {
  page.value = p
  fetchRecords()
}

function handleStatusChange(val: string) {
  statusFilter.value = val
  page.value = 1
  fetchRecords()
}

function handleSeasonChange(val: 'all' | SeasonStatus) {
  seasonFilter.value = val
  page.value = 1
  fetchRecords()
}

/** 标题模糊查询：回车或点「查询」触发，翻页时保留条件 */
function handleTitleSearch() {
  titleFilter.value = titleInput.value.trim()
  page.value = 1
  fetchRecords()
}

function handleTitleReset() {
  titleInput.value = ''
  titleFilter.value = ''
  page.value = 1
  fetchRecords()
}

// ---- 查看详情 ----
function showDetail(record: ReplayUploadRecord) {
  detailRecord.value = record
  detailVisible.value = true
}

// ---- 查看文件列表 ----
function formatSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes < 0) return '-'
  if (bytes === 0) return '0 B'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function showFiles(record: ReplayUploadRecord) {
  filesRecord.value = record
  try {
    filesContent.value = record.upload_files ? JSON.parse(record.upload_files) : []
  } catch {
    filesContent.value = []
  }
  filesVisible.value = true
}

// ---- 手动重试加入合集 ----
async function handleRetry(record: ReplayUploadRecord) {
  const ok = await confirm(retryConfirmMessage(record), {
    title: '加入合集',
    confirmText: '确认加入',
  })
  if (!ok) return

  retryingIds.value.add(record.id)
  try {
    const res = await apiPost(`/api/replay_upload_records/${record.id}/season/retry`)
    toast.success(res.message || '已触发加入合集，稍后刷新查看结果')
    await fetchRecords()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '重试触发失败')
  } finally {
    retryingIds.value.delete(record.id)
  }
}

// ---- 删除 ----
async function handleDelete(record: ReplayUploadRecord) {
  const ok = await confirm(`确定要删除回放投稿记录 #${record.id} 吗？`)
  if (!ok) return

  try {
    await apiDelete(`/api/replay_upload_records/${record.id}`)
    toast.success('删除成功')
    fetchRecords()
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '删除失败')
  }
}

// ---- 生命周期 ----
onMounted(fetchRecords)
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-gray-900 mb-6">回放投稿记录</h1>

    <!-- 筛选 -->
    <div class="bg-white rounded-xl border border-gray-200 p-4 mb-4 shadow-sm">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div class="flex items-center gap-2">
          <span class="text-sm text-gray-500 shrink-0">标题：</span>
          <input
            v-model="titleInput"
            type="text"
            placeholder="模糊搜索标题，回车查询"
            class="w-56 px-3 py-1 text-sm rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            @keyup.enter="handleTitleSearch"
          />
          <button
            class="px-3 py-1 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
            @click="handleTitleSearch"
          >
            查询
          </button>
          <button
            v-if="titleFilter"
            class="px-3 py-1 text-sm rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 transition-colors"
            @click="handleTitleReset"
          >
            清除
          </button>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-sm text-gray-500 shrink-0">状态：</span>
          <button
            v-for="opt in STATUS_FILTERS"
            :key="opt.value"
            class="px-3 py-1 text-xs font-medium rounded-full transition-colors"
            :class="
              statusFilter === opt.value
                ? 'bg-brand-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            "
            @click="handleStatusChange(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-sm text-gray-500 shrink-0">合集：</span>
          <button
            v-for="opt in SEASON_FILTERS"
            :key="opt.value"
            class="px-3 py-1 text-xs font-medium rounded-full transition-colors"
            :class="
              seasonFilter === opt.value
                ? 'bg-brand-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            "
            @click="handleSeasonChange(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <button
          class="ml-auto px-3 py-1 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
          :disabled="loading"
          @click="fetchRecords"
        >
          {{ loading ? '刷新中...' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading && records.length === 0" class="text-center py-12">
      <div
        class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"
      />
      <span class="text-sm text-gray-500">加载中...</span>
    </div>

    <!-- 表格 -->
    <div v-else class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div class="overflow-x-auto border-b border-gray-200">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-4 py-3 text-left font-medium text-gray-500">ID</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">主播</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">标题</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">投稿文件</th>
              <th class="px-4 py-3 text-center font-medium text-gray-500 w-20">状态</th>
              <th class="px-4 py-3 text-center font-medium text-gray-500 w-24">合集</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-26">BV号</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500 w-44">操作时间</th>
              <th class="px-4 py-3 text-right font-medium text-gray-500 w-80">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-if="records.length === 0">
              <td colspan="9" class="px-4 py-8 text-center text-gray-400">暂无回放投稿记录</td>
            </tr>
            <tr v-for="r in records" :key="r.id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3 text-gray-900 font-medium">{{ r.id }}</td>
              <td class="px-4 py-3 text-gray-600 text-xs">
                {{ r.principal_name || `#${r.replay_record_id}` }}
              </td>
              <td class="px-4 py-3">
                <div class="text-gray-900">{{ r.title || '-' }}</div>
                <div v-if="r.template_name" class="text-xs text-gray-400">
                  {{ r.template_name }}
                </div>
              </td>
              <td class="px-4 py-3">
                <button class="text-brand-600 hover:underline text-xs" @click="showFiles(r)">
                  {{ r.file_count }}个
                </button>
                <span class="text-xs text-gray-400 ml-1">[{{ formatSize(r.total_size) }}]</span>
              </td>
              <td class="px-4 py-3 text-center">
                <span
                  class="inline-block px-2 py-0.5 text-xs font-medium rounded-full"
                  :class="statusBadge(r.status).cls"
                >
                  {{ statusBadge(r.status).text }}
                </span>
              </td>
              <td class="px-4 py-3 text-center">
                <span
                  class="inline-block max-w-[7rem] truncate px-2 py-0.5 text-xs font-medium rounded-full align-middle"
                  :class="seasonBadge(r.season_status).cls"
                  :title="seasonTooltip(r)"
                >
                  {{ seasonBadge(r.season_status).text }}
                </span>
              </td>
              <td class="px-4 py-3">
                <a
                  v-if="r.bv_id"
                  :href="`https://www.bilibili.com/video/${r.bv_id}`"
                  target="_blank"
                  rel="noopener"
                  class="text-brand-600 hover:underline font-mono text-xs"
                >
                  {{ r.bv_id }}
                </a>
                <span v-else class="text-gray-400">-</span>
              </td>
              <td class="px-4 py-3 text-gray-500 text-xs">
                {{ $formatTime(r.started_at) }}<br />{{
                  r.completed_at
                    ? '完成: ' + $formatTime(r.completed_at, { format: 'HH:mm:ss' })
                    : ''
                }}
              </td>
              <td class="px-4 py-3 text-right">
                <div class="flex items-center justify-end gap-1">
                  <button
                    v-if="canRetry(r)"
                    class="px-2.5 py-1 text-xs font-medium rounded-lg border border-brand-200 text-brand-600 hover:bg-brand-50 transition-colors disabled:opacity-50"
                    :disabled="retryingIds.has(r.id)"
                    :title="seasonTooltip(r)"
                    @click="handleRetry(r)"
                  >
                    {{ retryingIds.has(r.id) ? '重试中' : '加合集' }}
                  </button>
                  <a
                    :href="getLogsPath(r)"
                    target="_blank"
                    class="flex items-center justify-end px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    <span>日志</span>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      class="size-3"
                    >
                      <path
                        d="M6.22 8.72a.75.75 0 0 0 1.06 1.06l5.22-5.22v1.69a.75.75 0 0 0 1.5 0v-3.5a.75.75 0 0 0-.75-.75h-3.5a.75.75 0 0 0 0 1.5h1.69L6.22 8.72Z"
                      />
                      <path
                        d="M3.5 6.75c0-.69.56-1.25 1.25-1.25H7A.75.75 0 0 0 7 4H4.75A2.75 2.75 0 0 0 2 6.75v4.5A2.75 2.75 0 0 0 4.75 14h4.5A2.75 2.75 0 0 0 12 11.25V9a.75.75 0 0 0-1.5 0v2.25c0 .69-.56 1.25-1.25 1.25h-4.5c-.69 0-1.25-.56-1.25-1.25v-4.5Z"
                      />
                    </svg>
                  </a>
                  <button
                    class="px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                    @click="showDetail(r)"
                  >
                    输出
                  </button>
                  <button
                    class="px-2.5 py-1 text-xs font-medium rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                    @click="handleDelete(r)"
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="px-4 pb-4">
        <Pagination
          :current="page"
          :total="total"
          :page-size="pageSize"
          @change="handlePageChange"
        />
      </div>
    </div>

    <!-- 输出详情弹窗 -->
    <Modal v-model:visible="detailVisible" :title="`输出详情 - #${detailRecord?.id}`">
      <div class="px-6 py-4">
        <pre
          class="text-xs text-gray-700 whitespace-pre-wrap break-all font-mono bg-gray-50 rounded-lg p-4"
          >{{ detailRecord?.output || '(无输出)' }}</pre
        >
      </div>
    </Modal>

    <!-- 文件列表弹窗 -->
    <Modal v-model:visible="filesVisible" :title="`投稿文件 - #${filesRecord?.id}`">
      <div class="px-6 py-4">
        <table v-if="filesContent.length > 0" class="w-full text-sm">
          <thead>
            <tr>
              <th class="text-left font-medium text-gray-500 pb-2">#</th>
              <th class="text-left font-medium text-gray-500 pb-2">文件路径</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(fp, i) in filesContent" :key="i" class="border-t border-gray-100">
              <td class="py-2 text-gray-500 pr-4">{{ i + 1 }}</td>
              <td class="py-2 text-gray-700 text-xs font-mono break-all">{{ fp }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="text-center text-gray-400 py-8">无文件记录</div>
      </div>
    </Modal>
  </div>
</template>
