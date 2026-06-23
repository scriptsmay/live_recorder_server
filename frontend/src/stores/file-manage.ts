import { defineStore } from 'pinia'
import { ref } from 'vue'
import { apiGet, apiPost } from '@/utils/api'
import { useToast } from '@/utils/toast'
import type {
  ManagedFile,
  FileDetail,
  FileSummary,
  FileListParams,
  DeletePlan,
  DeleteTaskStatus,
  DeleteResult,
} from '@/types/file-manage'

export const useFileStore = defineStore('file-manage', () => {
  const toast = useToast()

  // ---- 空间概览 ----
  const summary = ref<FileSummary | null>(null)
  const summaryLoading = ref(false)

  async function fetchSummary() {
    summaryLoading.value = true
    try {
      const res = await apiGet<FileSummary>('/api/files/summary')
      summary.value = res.data
    } catch (err) {
      toast.error('查询空间概览失败: ' + (err instanceof Error ? err.message : ''))
    } finally {
      summaryLoading.value = false
    }
  }

  // ---- 文件列表 ----
  const fileList = ref<ManagedFile[]>([])
  const fileListTotal = ref(0)
  const fileListLoading = ref(false)
  const fileListPage = ref(1)
  const fileListLimit = ref(50)

  async function fetchFileList(params: FileListParams = {}) {
    fileListLoading.value = true
    try {
      const query = new URLSearchParams()
      if (params.type) query.set('type', params.type)
      if (params.category) query.set('category', params.category)
      if (params.status) query.set('status', params.status)
      if (params.exists_on_disk !== undefined)
        query.set('exists_on_disk', String(params.exists_on_disk))
      if (params.safe_to_delete !== undefined)
        query.set('safe_to_delete', String(params.safe_to_delete))
      if (params.ext) query.set('ext', params.ext)
      if (params.min_size) query.set('min_size', String(params.min_size))
      if (params.start_date) query.set('start_date', params.start_date)
      if (params.end_date) query.set('end_date', params.end_date)
      if (params.session_id) query.set('session_id', String(params.session_id))
      query.set('page', String(params.page || fileListPage.value))
      query.set('limit', String(params.limit || fileListLimit.value))
      if (params.sort) query.set('sort', params.sort)

      const url = `/api/files?${query.toString()}`
      const res = await apiGet<ManagedFile[]>(url)
      fileList.value = res.data ?? []
      fileListTotal.value = res.total ?? 0
      fileListPage.value = res.page ?? 1
      fileListLimit.value = res.limit ?? 50
    } catch (err) {
      toast.error('查询文件列表失败: ' + (err instanceof Error ? err.message : ''))
    } finally {
      fileListLoading.value = false
    }
  }

  // ---- 文件详情 ----
  const fileDetail = ref<FileDetail | null>(null)
  const fileDetailLoading = ref(false)

  async function fetchFileDetail(id: number) {
    fileDetailLoading.value = true
    try {
      const res = await apiGet<FileDetail>(`/api/files/${id}`)
      fileDetail.value = res.data
    } catch (err) {
      toast.error('查询文件详情失败: ' + (err instanceof Error ? err.message : ''))
    } finally {
      fileDetailLoading.value = false
    }
  }

  // ---- 删除计划 ----
  const deletePlan = ref<DeletePlan | null>(null)
  const deletePlanLoading = ref(false)

  async function generateDeletePlan(input: {
    file_ids?: number[]
    filters?: Record<string, unknown>
  }) {
    deletePlanLoading.value = true
    try {
      const res = await apiPost<DeletePlan>('/api/files/delete-plan', input)
      deletePlan.value = res.data
      return res.data
    } catch (err) {
      toast.error('生成删除计划失败: ' + (err instanceof Error ? err.message : ''))
      return null
    } finally {
      deletePlanLoading.value = false
    }
  }

  // ---- 执行删除（异步批量） ----
  const deleteTaskStatus = ref<DeleteTaskStatus | null>(null)
  const deleteExecuting = ref(false)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function executeDelete(planId: string): Promise<string | null> {
    deleteExecuting.value = true
    try {
      const res = await apiPost<{ task_id: string; status: string }>('/api/files/delete', {
        plan_id: planId,
        confirm: true,
      })
      return res.data.task_id
    } catch (err) {
      toast.error('执行删除失败: ' + (err instanceof Error ? err.message : ''))
      return null
    } finally {
      deleteExecuting.value = false
    }
  }

  async function fetchDeleteTaskStatus(taskId: string) {
    try {
      const res = await apiGet<DeleteTaskStatus>(`/api/files/delete-tasks/${taskId}`)
      deleteTaskStatus.value = res.data
      return res.data
    } catch {
      return null
    }
  }

  function startPollingDeleteTask(taskId: string, onComplete?: (status: DeleteTaskStatus) => void) {
    stopPollingDeleteTask()
    pollTimer = setInterval(async () => {
      const status = await fetchDeleteTaskStatus(taskId)
      if (status && status.status === 'completed') {
        stopPollingDeleteTask()
        onComplete?.(status)
      }
    }, 1000)
  }

  function stopPollingDeleteTask() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  // ---- 单文件删除 ----
  async function deleteSingleFile(fileId: number): Promise<DeleteResult | null> {
    try {
      const res = await apiPost<DeleteResult>(`/api/files/${fileId}/delete`)
      return res.data
    } catch (err) {
      toast.error('删除文件失败: ' + (err instanceof Error ? err.message : ''))
      return null
    }
  }

  // ---- 触发扫描 ----
  const scanLoading = ref(false)

  async function triggerScan() {
    scanLoading.value = true
    try {
      const res = await apiPost<{
        scanned: number
        created: number
        updated: number
        missing: number
      }>('/api/files/scan')
      toast.success(`扫描完成: ${res.data.scanned} 个文件已索引`)
      await fetchSummary()
      await fetchFileList()
      return res.data
    } catch (err) {
      toast.error('扫描失败: ' + (err instanceof Error ? err.message : ''))
      return null
    } finally {
      scanLoading.value = false
    }
  }

  return {
    // 概览
    summary,
    summaryLoading,
    fetchSummary,
    // 列表
    fileList,
    fileListTotal,
    fileListLoading,
    fileListPage,
    fileListLimit,
    fetchFileList,
    // 详情
    fileDetail,
    fileDetailLoading,
    fetchFileDetail,
    // 删除计划
    deletePlan,
    deletePlanLoading,
    generateDeletePlan,
    // 删除执行
    deleteTaskStatus,
    deleteExecuting,
    executeDelete,
    fetchDeleteTaskStatus,
    startPollingDeleteTask,
    stopPollingDeleteTask,
    // 单文件删除
    deleteSingleFile,
    // 扫描
    scanLoading,
    triggerScan,
  }
})
