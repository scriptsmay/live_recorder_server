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
import type { UploadRecord, PaginatedResponse } from '@/types/api'

const toast = useToast()
const { confirm } = useConfirm()

// ---- 列表状态 ----
const records = ref<UploadRecord[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)

// ---- 详情弹窗 ----
const detailVisible = ref(false)
const detailRecord = ref<UploadRecord | null>(null)

// ---- 工具函数 ----
function formatDate(d: string | null | undefined) {
  if (!d) return '-'
  return new Date(d).toLocaleString('zh-CN')
}

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
      `/api/upload_records?limit=50&page=${page.value}`,
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
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-4 py-3 text-left font-medium text-gray-500">ID</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">会话 ID</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">模板</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">状态</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">BV 号</th>
              <th class="px-4 py-3 text-left font-medium text-gray-500">创建时间</th>
              <th class="px-4 py-3 text-right font-medium text-gray-500">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-if="records.length === 0">
              <td colspan="7" class="px-4 py-8 text-center text-gray-400">暂无投稿记录</td>
            </tr>
            <tr v-for="r in records" :key="r.id" class="hover:bg-gray-50 transition-colors">
              <td class="px-4 py-3 text-gray-900 font-medium">{{ r.id }}</td>
              <td class="px-4 py-3 text-gray-600">{{ r.session_id ?? '-' }}</td>
              <td class="px-4 py-3 text-gray-600">{{ r.template_name || '-' }}</td>
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
              <td class="px-4 py-3 text-gray-500 text-xs">{{ formatDate(r.created_at) }}</td>
              <td class="px-4 py-3 text-right">
                <div class="flex items-center justify-end gap-2">
                  <button
                    class="px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                    @click="showDetail(r)"
                  >
                    查看详情
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
    <Teleport to="body">
      <div v-if="detailVisible" class="fixed inset-0 z-50 flex items-center justify-center">
        <div class="fixed inset-0 bg-black/40" @click="closeDetail" />
        <div
          class="relative bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col"
        >
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <h3 class="text-lg font-semibold text-gray-900">输出详情 - #{{ detailRecord?.id }}</h3>
            <button
              class="text-gray-400 hover:text-gray-600 transition-colors"
              @click="closeDetail"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <div class="px-6 py-4 overflow-y-auto flex-1">
            <pre
              class="text-xs text-gray-700 whitespace-pre-wrap break-all font-mono bg-gray-50 rounded-lg p-4"
              >{{ detailRecord?.output || '(无输出)' }}</pre
            >
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
