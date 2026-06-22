import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { apiGet, apiPost, apiPut, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'
import type {
  ReplayPrincipal,
  ReplayRecord,
  ReplaySettings,
  ReplayTaskStatus,
  ReplayUploadPreview,
  ReplayUploadRecord,
} from '@/types/api'

export const useReplayToolboxStore = defineStore('replay-toolbox', () => {
  const toast = useToast()

  const principals = ref<ReplayPrincipal[]>([])
  const records = ref<ReplayRecord[]>([])
  const uploads = ref<ReplayUploadRecord[]>([])
  const taskStatus = ref<ReplayTaskStatus | null>(null)
  const settings = ref<ReplaySettings | null>(null)
  const selectedPrincipalId = ref<string>('')
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(20)
  const dateFrom = ref('')
  const dateTo = ref('')
  const loadingPrincipals = ref(false)
  const loadingRecords = ref(false)
  const loadingUploads = ref(false)
  const busy = ref(false)

  const selectedPrincipal = computed(
    () => principals.value.find((item) => item.principal_id === selectedPrincipalId.value) ?? null,
  )

  function getErrorMessage(err: unknown) {
    return err instanceof ApiError || err instanceof Error ? err.message : '未知错误'
  }

  async function fetchPrincipals() {
    loadingPrincipals.value = true
    try {
      const res = await apiGet<ReplayPrincipal[]>('/api/replay/principals')
      principals.value = res.data ?? []
      if (!selectedPrincipalId.value && principals.value.length > 0) {
        selectedPrincipalId.value = principals.value[0].principal_id
      }
    } catch (err) {
      toast.error('加载回放主播失败: ' + getErrorMessage(err))
    } finally {
      loadingPrincipals.value = false
    }
  }

  async function fetchRecords(options: { status?: string; page?: number } = {}) {
    if (!selectedPrincipalId.value) {
      records.value = []
      total.value = 0
      return
    }
    loadingRecords.value = true
    try {
      const nextPage = options.page ?? page.value
      const params = new URLSearchParams({
        page: String(nextPage),
        page_size: String(pageSize.value),
      })
      if (options.status && options.status !== 'all') {
        params.set('status', options.status)
      }
      if (dateFrom.value) params.set('date_from', dateFrom.value)
      if (dateTo.value) params.set('date_to', dateTo.value)
      const res = await apiGet<ReplayRecord[]>(
        `/api/replay/principals/${encodeURIComponent(selectedPrincipalId.value)}/records?${params}`,
      )
      const body = res as unknown as {
        data?: ReplayRecord[]
        total?: number
        page?: number
        page_size?: number
      }
      records.value = body.data ?? []
      total.value = body.total ?? records.value.length
      page.value = nextPage
    } catch (err) {
      toast.error('加载回放记录失败: ' + getErrorMessage(err))
    } finally {
      loadingRecords.value = false
    }
  }

  async function fetchUploads() {
    if (!selectedPrincipalId.value) {
      uploads.value = []
      return
    }
    loadingUploads.value = true
    try {
      const res = await apiGet<ReplayUploadRecord[]>(
        `/api/replay/principals/${encodeURIComponent(selectedPrincipalId.value)}/uploads`,
      )
      uploads.value = res.data ?? []
    } catch (err) {
      uploads.value = []
      toast.error('加载投稿记录失败: ' + getErrorMessage(err))
    } finally {
      loadingUploads.value = false
    }
  }

  async function fetchTaskStatus() {
    try {
      const res = await apiGet<ReplayTaskStatus>('/api/replay/tasks')
      taskStatus.value = res.data ?? null
    } catch {
      /* queue status is non-critical */
    }
  }

  async function fetchSettings() {
    if (!selectedPrincipalId.value) {
      settings.value = null
      return
    }
    try {
      const res = await apiGet<ReplaySettings>(
        `/api/replay/principals/${encodeURIComponent(selectedPrincipalId.value)}/settings`,
      )
      settings.value = res.data ?? null
    } catch (err) {
      toast.error('加载回放配置失败: ' + getErrorMessage(err))
    }
  }

  async function selectPrincipal(principalId: string, status = 'all') {
    selectedPrincipalId.value = principalId
    page.value = 1
    await Promise.all([fetchRecords({ status, page: 1 }), fetchUploads(), fetchSettings()])
  }

  async function syncRecords(count: number, dryRun = false) {
    if (!selectedPrincipalId.value) return false
    busy.value = true
    try {
      const res = await apiPost('/api/replay/records/sync', {
        principal_id: selectedPrincipalId.value,
        count,
        dry_run: dryRun,
      })
      toast.success(res.message ?? (dryRun ? 'dry-run 完成' : '同步完成'))
      await Promise.all([fetchPrincipals(), fetchRecords({ page: 1 })])
      return true
    } catch (err) {
      toast.error('同步失败: ' + getErrorMessage(err))
      return false
    } finally {
      busy.value = false
    }
  }

  async function enqueueRecord(recordId: number, action: string, force = false) {
    busy.value = true
    try {
      const res = await apiPost(`/api/replay/records/${recordId}/actions/${action}`, { force })
      toast.success(res.message ?? '任务已入队')
      await fetchTaskStatus()
      return true
    } catch (err) {
      toast.error('入队失败: ' + getErrorMessage(err))
      return false
    } finally {
      busy.value = false
    }
  }

  async function cancelRecord(recordId: number) {
    busy.value = true
    try {
      const res = await apiPost(`/api/replay/records/${recordId}/cancel`)
      toast.success(res.message ?? '任务已取消')
      await Promise.all([fetchTaskStatus(), fetchRecords({ page: page.value })])
      return true
    } catch (err) {
      toast.error('取消失败: ' + getErrorMessage(err))
      return false
    } finally {
      busy.value = false
    }
  }

  async function markRecordsCompleted(ids: number[]) {
    const recordIds = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)))
    if (recordIds.length === 0) return false

    busy.value = true
    try {
      const res = await apiPost<{ updated?: ReplayRecord[]; missing_ids?: number[] }>(
        '/api/replay/records/mark-completed',
        { ids: recordIds },
      )
      toast.success(res.message ?? `已标记 ${res.data?.updated?.length ?? 0} 条回放为已完成`)
      await Promise.all([fetchPrincipals(), fetchRecords({ page: page.value })])
      return true
    } catch (err) {
      toast.error('标记完成失败: ' + getErrorMessage(err))
      return false
    } finally {
      busy.value = false
    }
  }

  async function fetchUploadPreview(recordId: number) {
    const res = await apiGet<ReplayUploadPreview>(`/api/replay/records/${recordId}/upload-preview`)
    return res.data ?? null
  }

  async function enqueuePrincipal(count: number, dryRun = false) {
    if (!selectedPrincipalId.value) return false
    busy.value = true
    try {
      const res = await apiPost<{ enqueued?: number; candidates?: ReplayRecord[] }>(
        '/api/replay/tasks/enqueue',
        {
          principal_id: selectedPrincipalId.value,
          count,
          skip_completed: true,
          dry_run: dryRun,
        },
      )
      const countText = dryRun
        ? `${res.data?.candidates?.length ?? 0} 条候选`
        : `${res.data?.enqueued ?? 0} 条`
      toast.success(res.message ?? `批量入队完成: ${countText}`)
      await fetchTaskStatus()
      return true
    } catch (err) {
      toast.error('批量入队失败: ' + getErrorMessage(err))
      return false
    } finally {
      busy.value = false
    }
  }

  async function updateSettings(next: ReplaySettings) {
    if (!selectedPrincipalId.value) return false
    busy.value = true
    try {
      await apiPut(
        `/api/replay/principals/${encodeURIComponent(selectedPrincipalId.value)}/settings`,
        next,
      )
      toast.success('回放配置已保存')
      await fetchSettings()
      return true
    } catch (err) {
      toast.error('保存配置失败: ' + getErrorMessage(err))
      return false
    } finally {
      busy.value = false
    }
  }

  return {
    principals,
    records,
    uploads,
    taskStatus,
    settings,
    selectedPrincipalId,
    selectedPrincipal,
    total,
    page,
    pageSize,
    loadingPrincipals,
    loadingRecords,
    loadingUploads,
    dateFrom,
    dateTo,
    busy,
    fetchPrincipals,
    fetchRecords,
    fetchUploads,
    fetchTaskStatus,
    fetchSettings,
    selectPrincipal,
    syncRecords,
    enqueueRecord,
    cancelRecord,
    markRecordsCompleted,
    fetchUploadPreview,
    enqueuePrincipal,
    updateSettings,
  }
})
