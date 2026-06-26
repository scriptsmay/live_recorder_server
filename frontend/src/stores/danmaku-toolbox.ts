import { defineStore } from 'pinia'
import { ref } from 'vue'
import { apiGet } from '@/utils/api'
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

  // const sessions = ref<ToolboxSession[]>([])
  const loading = ref(false)

  // /** 加载会话列表 */
  // async function fetchSessions() {
  //   loading.value = true
  //   try {
  //     const res = await apiGet<ToolboxSession[]>('/api/danmaku-toolbox/sessions')
  //     sessions.value = res.data ?? []
  //   } catch (err) {
  //     toast.error('加载会话列表失败: ' + (err instanceof Error ? err.message : '未知错误'))
  //   } finally {
  //     loading.value = false
  //   }
  // }

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
    try {
      const res = await apiGet<DanmakuSearchResult[]>(`/api/danmaku/search?${params}`)
      return {
        results: res.data ?? [],
        total: (res as unknown as { total: number }).total ?? 0,
        limit,
      }
    } catch (err) {
      toast.error('搜索弹幕失败: ' + (err instanceof Error ? err.message : '未知错误'))
    }
    return {
      results: [],
      total: 0,
      limit,
    }
  }

  return {
    // sessions,
    loading,
    // fetchSessions,
    searchDanmaku,
  }
})
