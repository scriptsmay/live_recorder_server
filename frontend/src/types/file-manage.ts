// ====== 文件管理模块 ======

export type FileCategory = 'recording' | 'replay' | 'danmaku' | 'orphan'

export type FileType =
  | 'recording_file'
  | 'hls_directory'
  | 'replay_raw'
  | 'replay_cut'
  | 'replay_fixed'
  | 'replay_final'
  | 'danmaku_output'
  | 'danmaku_archive'
  | 'danmaku_ass_cache'
  | 'orphan'

export type FileStatus = 'active' | 'deleting' | 'deleted' | 'missing'

export interface ManagedFile {
  id: number
  category: FileCategory
  file_type: FileType
  source_table: string | null
  source_id: number | null
  group_id: string | null
  file_path: string
  file_name: string | null
  extension: string | null
  file_size: number | null
  mtime: string | null
  exists_on_disk: boolean
  status: FileStatus
  safe_to_delete: boolean
  delete_block_reason: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface FileDetail extends ManagedFile {
  active_task: { type: string } | null
  recent_audits: AuditLog[]
}

export interface FileSummaryGroup {
  type: string
  root: string | null
  size: number
  file_count: number
}

export interface FileSummary {
  total_size: number
  safe_to_delete_size: number
  groups: FileSummaryGroup[]
}

export interface DeletableFile {
  file_id: number
  file_path: string
  file_name: string | null
  file_size: number | null
  category: FileCategory
  file_type: FileType
  source_table: string | null
  source_id: number | null
}

export interface BlockedFile {
  file_id: number
  file_path: string
  file_name: string | null
  reason: string
}

export interface DeletePlan {
  plan_id: string
  expires_at: string
  deletable_count: number
  blocked_count: number
  total_size: number
  deletable: DeletableFile[]
  blocked: BlockedFile[]
}

export interface DeleteTaskStatus {
  task_id: string
  plan_id: string
  status: 'processing' | 'completed'
  total_count: number
  deleted_count: number
  blocked_count: number
  failed_count: number
  estimated_release_size: number
  actual_release_size: number
  operator: string
  results: DeleteResult[]
  created_at: string
}

export interface DeleteResult {
  file_id: number
  file_path: string
  result: 'success' | 'success_noop' | 'blocked' | 'failed'
  error: string | null
  actual_release_size: number
}

export interface AuditLog {
  id: number
  action: string
  result: string
  operator: string
  deleted_by: string
  created_at: string
  error_message: string | null
}

export interface FileListParams {
  type?: FileType
  category?: FileCategory
  status?: FileStatus
  exists_on_disk?: boolean | string
  safe_to_delete?: boolean | string
  ext?: string
  min_size?: string | number
  start_date?: string
  end_date?: string
  session_id?: string | number
  page?: number
  limit?: number
  sort?: string
}
