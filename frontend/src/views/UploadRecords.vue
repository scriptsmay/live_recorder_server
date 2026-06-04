<script setup lang="ts">
/**
 * 投稿记录 - 查看投稿历史
 *
 * 从 upload_records.ejs 迁移
 * - 投稿记录列表（分页，每页 50 条）
 * - 查看输出详情（弹窗）
 * - 删除记录（确认对话框）
 */
import { ref, onMounted } from 'vue'
import { apiGet, apiDelete, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import { useConfirm } from '@/utils/confirm'
import Pagination from '@/components/Pagination.vue'
import Modal from '@/components/Modal.vue'
import type { UploadRecord, PaginatedResponse } from '@/types/api'

const toast = useToast()
const { confirm } = useConfirm()

// ---- 列表状态 ----
const records = ref<UploadRecord[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
// 每页 N 条，避免分页异常
const pageSize = 10

// ---- 详情弹窗 ----
const detailVisible = ref(false)
const detailRecord = ref<UploadRecord | null>(null)

// ---- 文件列表弹窗 ----
const filesVisible = ref(false)
const filesRecord = ref<UploadRecord | null>(null)
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

// ---- 数据加载 ----
async function fetchRecords() {
  loading.value = true
  try {
    const res = await apiGet<PaginatedResponse<UploadRecord>>(
      `/api/upload_records?limit=${pageSize}&page=${page.value}`,
    )
    records.value = res.data.rows
    total.value = res.data.total
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : '加载投稿记录失败')
  } finally {
    loading.value = false
  }
}

function handlePageChange(p: number) {
  page.value = p
  fetchRecords()
}

// ---- 查看详情 ----
function showDetail(record: UploadRecord) {
  detailRecord.value = record
  detailVisible.value = true
}

function closeDetail() {
  detailVisible.value = false
  detailRecord.value = null
}

// ---- 查看文件列表 ----
function formatSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes < 0) return '-'
  if (bytes === 0) return '0 B'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function showFiles(record: UploadRecord) {
  filesRecord.value = record
  try {
    filesContent.value = record.upload_files ? JSON.parse(record.upload_files) : []
  } catch {
    filesContent.value = []
  }
  filesVisible.value = true
}

function closeFiles() {
  filesVisible.value = false
  filesRecord.value = null
  filesContent.value = []
}

// ---- 删除 ----
async function handleDelete(record: UploadRecord) {
  const ok = await confirm(`确定要删除投稿记录 #${record.id} 吗？`)
  if (!ok) return

  try {
    await apiDelete(`/api/upload_records/${record.id}`)
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
    <h1 class="text-2xl font-bold text-gray-900 mb-6">投稿记录</h1>

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
              <th class="px-4 py-3 text-left font-medium text-gray-500">会话 ID</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">标题</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">投稿文件</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">状态</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">BV号</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">开始时间</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">结束时间</th>
              <th class="px-4 py-3 text-right font-medium text-gray-500">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-if="records.length === 0">
              <td colspan="9" class="px-4 py-8 text-center text-gray-400">暂无投稿记录</td>
            </tr>
            <tr v-for="r in records" :key="r.id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3 text-gray-900 font-medium">{{ r.id }}</td>
              <td class="px-4 py-3 text-gray-600">{{ r.session_id ?? '-' }}</td>
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
              <td class="px-4 py-3">
                <span
                  class="inline-block px-2 py-0.5 text-xs font-medium rounded-full"
                  :class="statusBadge(r.status).cls"
                >
                  {{ statusBadge(r.status).text }}
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
              <td class="px-4 py-3 text-gray-500 text-xs">{{ $formatTime(r.started_at) }}</td>
              <td class="px-4 py-3 text-gray-500 text-xs">
                {{ r.completed_at ? $formatTime(r.completed_at) : '-' }}
              </td>
              <td class="px-4 py-3 text-right">
                <div class="flex items-center justify-end gap-2">
                  <a
                    :href="`/logs?file=${encodeURIComponent('biliup_' + r.id + '.log')}`"
                    target="_blank"
                    class="flex items-center justify-end px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    <span>日志</span>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      class="size-4"
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
                    查看输出
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
        <Pagination :current="page" :total="total" @change="handlePageChange" />
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
