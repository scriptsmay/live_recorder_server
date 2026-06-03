import { defineStore } from 'pinia'
import { ref } from 'vue'
import { apiGet, apiPost, apiDelete, ApiError } from '@/utils/api'
import { useToast } from '@/utils/toast'

// ---- 类型定义 ----

export interface ToolboxSession {
  id: number
  room_url: string
  room_name: string | null
  status: string
  started_at: string
  ended_at: string | null
  total_segments: number | null
  total_size: number | null
  danmaku_status: string
  danmaku_event_count: number
  danmaku_error: string | null
  danmaku_burn_total: number
  danmaku_burn_completed: number
  danmaku_burn_failed: number
  ass_segment_count: number
  has_ass_ready: boolean
}

export interface QueueStatus {
  active_captures: { count: number } | null
  burn_queue: { queue_length: number; processing: number; concurrency: number } | null
}

export interface RecordingFile {
  id: number
  segment_index: number
  file_path: string
  file_size: number | null
  danmaku_ass_path: string | null
  danmaku_ass_exists: boolean
}

export interface BurnRecord {
  id: number
  recording_file_id: number
  session_id: number
  status: string
  output_path: string | null
  log_path: string | null
  error: string | null
}

export interface DanmakuSearchResult {
  ts_ms: number | null
  ts_str: string
  text: string
  username: string
  user_id: string
}

// ---- Store ----

export const useDanmakuToolboxStore = defineStore('danmaku-toolbox', () => {
  const toast = useToast()

  const sessions = ref<ToolboxSession[]>([])
  const queueStatus = ref<QueueStatus | null>(null)
  const loading = ref(false)

  /** 加载会话列表 */
  async function fetchSessions() {
    loading.value = true
    try {
      const res = await apiGet<ToolboxSession[]>('/api/danmaku-toolbox/sessions')
      sessions.value = res.data ?? []
    } catch (err) {
      toast.error('加载会话列表失败: ' + (err instanceof Error ? err.message : '未知错误'))
    } finally {
      loading.value = false
    }
  }

  /** 加载队列状态 */
  async function fetchQueueStatus() {
    try {
      const res = await apiGet<QueueStatus>('/api/danmaku/status')
      queueStatus.value = res.data ?? null
    } catch {
      // 静默失败，不影响主流程
    }
  }

  /** 生成 ASS */
  async function generateAss(sessionId: number): Promise<boolean> {
    try {
      const res = await apiPost<{ event_count: number }>(`/api/sessions/${sessionId}/danmaku/ass`)
      if (res.status === 'ok') {
        toast.success(`ASS 生成成功: ${res.data?.event_count ?? '?'} 条弹幕`)
        return true
      }
      toast.error('生成失败: ' + (res.message ?? ''))
      return false
    } catch (err) {
      toast.error('请求失败: ' + (err instanceof ApiError ? err.message : '未知错误'))
      return false
    }
  }

  /** 压制会话 */
  async function burnSession(sessionId: number, force = false): Promise<boolean> {
    try {
      const res = await apiPost<{ enqueued: number }>(`/api/sessions/${sessionId}/danmaku/burn`, {
        force,
      })
      if (res.status === 'ok') {
        toast.success(res.message ?? `已入队`)
        return true
      }
      toast.error('入队失败: ' + (res.message ?? ''))
      return false
    } catch (err) {
      toast.error('请求失败: ' + (err instanceof ApiError ? err.message : '未知错误'))
      return false
    }
  }

  /** 删除压制记录 */
  async function deleteBurnRecord(burnId: number): Promise<boolean> {
    try {
      await apiDelete(`/api/danmaku_burn_records/${burnId}?delete_file=true`)
      toast.success('已删除')
      return true
    } catch (err) {
      toast.error('删除失败: ' + (err instanceof ApiError ? err.message : '未知错误'))
      return false
    }
  }

  /** 加载分段文件 */
  async function fetchSegments(sessionId: number): Promise<{
    files: RecordingFile[]
    burnRecords: BurnRecord[]
  }> {
    const [filesRes, burnRes] = await Promise.all([
      apiGet<{ rows: RecordingFile[]; total: number }>(
        `/api/recording_files?session_id=${sessionId}`,
      ),
      apiGet<BurnRecord[]>(`/api/danmaku_burn_records?session_id=${sessionId}`),
    ])
    const filesData = filesRes.data
    return {
      files: Array.isArray(filesData) ? filesData : (filesData?.rows ?? []),
      burnRecords: burnRes.data ?? [],
    }
  }

  /** 搜索弹幕 */
  async function searchDanmaku(
    sessionId: number,
    keyword: string,
    offset = 0,
    limit = 50,
  ): Promise<{ results: DanmakuSearchResult[]; total: number; limit: number }> {
    const params = new URLSearchParams({
      session_id: String(sessionId),
      keyword,
      limit: String(limit),
      offset: String(offset),
    })
    const res = await apiGet<DanmakuSearchResult[]>(`/api/danmaku/search?${params}`)
    return {
      results: res.data ?? [],
      total: (res as unknown as { total: number }).total ?? 0,
      limit,
    }
  }

  return {
    sessions,
    queueStatus,
    loading,
    fetchSessions,
    fetchQueueStatus,
    generateAss,
    burnSession,
    deleteBurnRecord,
    fetchSegments,
    searchDanmaku,
  }
})
