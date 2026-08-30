/**
 * 通用 API 响应类型
 */

export interface PaginatedResponse<T> {
  rows: T[]
  total: number
}

export interface PaginationMeta {
  page: number
  total: number
  totalPages: number
}

// ====== 直播间 ======

export interface Room {
  id: number
  room_url: string
  room_name: string
  platform: string
  status: 'idle' | 'recording' | 'paused'
  notification_enabled: boolean
  monitoring_enabled: boolean
  polling_enabled: boolean
  polling_interval: number
  polling_platform: string | null
  last_live_status: boolean
  last_polled_at: string | null
  segment_duration: number
  filename_template: string
  upload_template_id: number | null
  upload_template_name: string
  created_at: string
  updated_at: string
}

export interface RoomFormData {
  room_url?: string
  room_name: string
  filename_template: string
  segment_duration: number
  notification_enabled: boolean
  monitoring_enabled: boolean
  upload_template_id: number | null
  polling_enabled: boolean
  polling_interval: number
}

// ====== 录制会话 ======

export interface RecordingSession {
  id: number
  room_id: number
  room_url: string
  room_name: string
  status: 'pending' | 'recording' | 'completed' | 'interrupted'
  started_at: string
  ended_at: string | null
  caption: string
  output_path: string
  stream_url: string
  total_segments: number
  total_size: number
  danmaku_status: string
  danmaku_event_count: number
  danmaku_error: string | null
  burn_status: string | null
  upload_records?: SessionUpload[]
  created_at: string
}

export interface SessionUpload {
  id: number
  session_id: number
  status: string
  bv_id: string | null
}

// ====== 录制文件 ======

export interface RecordingFile {
  id: number
  session_id: number
  file_path: string
  file_size: number
  duration: number | null
  status: string
  file_exists: boolean
  is_hls_ready: boolean
  created_at: string
}

// ====== 投稿模板 ======

export interface UploadTemplate {
  id: number
  name: string
  cookies_path: string
  title_template: string
  desc_template: string
  tags: string
  source: string
  tid: number | null
  copyright: number | null
  is_only_self: number
  cover: string | null
  dtime: number | null
  after_upload: string | null
  use_room_cover: boolean | null
  created_at: string
  updated_at: string
}

export interface UploadTemplateFormData {
  name: string
  cookies_path: string
  title_template: string
  desc_template: string
  tags: string
  source: string
  tid: number | null
  copyright: number | null
  is_only_self: number
  cover: string
  dtime: number | null
  after_upload: string
  use_room_cover: boolean
}

// ====== 投稿记录 ======

export interface UploadRecord {
  id: number
  source?: 'recording' | 'replay'
  session_id: number | null
  template_id: number | null
  template_name?: string
  principal_name?: string
  title: string
  status: string
  message: string | null
  output: string | null
  error_message: string | null
  file_count: number
  total_size: number
  upload_files: string
  bv_id: string | null
  started_at: string
  completed_at: string | null
  created_at: string
}

// ====== 转码记录 ======

export interface TranscodeRecord {
  id: number
  recording_file_id: number
  original_path: string
  output_path: string
  status: string
  error: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

// ====== 回放工具箱 ======

export type ReplayRecordStatus =
  | 'pending'
  | 'extracted'
  | 'downloaded'
  | 'cut'
  | 'fixed'
  | 'uploaded'
  | 'completed'
  | 'backed_up'
  | 'cancelled'
  | 'failed'

export interface ReplayPrincipal {
  principal_id: string
  principal_name: string
  room_id: number
  room_url: string
  room_name: string
  replay_count: number
  latest_replay_time: string | null
  latest_status: ReplayRecordStatus | null
}

export interface ReplayRecord {
  id: number
  principal_id: string
  principal_name: string
  replay_id: string
  play_url: string
  m3u8_url: string
  video_file_name: string
  status: ReplayRecordStatus
  raw_file_path: string | null
  cut_file_paths: string | null
  fixed_file_paths: string | null
  final_file_paths: string | null
  file_size: number | null
  bv_id: string | null
  start_time: string | null
  duration: number | null
  uploaded_at: string | null
  backed_up_at: string | null
  completed_at: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  resolution: string | null
  poster: string | null
}

export interface ReplayUploadRecord {
  id: number
  replay_record_id: number
  template_id: number | null
  title: string
  status: string
  message: string | null
  output: string | null
  error_message: string | null
  file_count: number
  total_size: number
  bv_id: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  principal_id: string
  principal_name: string
  replay_id: string
}

export interface ReplayTaskStatus {
  queue_length: number
  processing: number
  concurrency: number
  active?: Array<{
    record_id: number
    principal_id: string
    action: string
    step: string
    pid: number | null
    command: string
    started_at: string
  }>
}

export interface ReplaySettings {
  principal_name: string
  upload_template_id: string
  auto_upload: string
  max_count_per_run: string
}

export interface ReplayUploadPreview {
  title: string
  desc: string
  desc_full: string
  tags: string
  template_name: string
  cover_source: 'room' | 'template' | 'none'
  cover_path: string
}

// ====== 仪表盘 ======

export interface DashboardStatus {
  active_recordings: ActiveRecording[]
  active_count: number
  pool_size: number
  transcode: {
    queue_length: number
    processing: number
    concurrency: number
  }
  replay?: {
    queue_length: number
    processing: number
    concurrency: number
  }
  danmaku?: DashboardDanmaku
  polling?: DashboardPolling
  summary?: DashboardSummary
  recent_activity?: ActivityItem[]
}

export interface ActiveRecording {
  room_url: string
  room_name: string
  room_id: number | null
  pid: number
  session_id: number
  started_at: string
  downloader: string
}

export interface DashboardDanmaku {
  active_captures: number
}

export interface DashboardPolling {
  total_polled: number
  total_rooms: number
  currently_live: number
  platform_breakdown: Record<string, { total: number; live: number }>
}

export interface DashboardSummary {
  sessions_today: number
  sessions_today_total_size: number
  interrupted_today: number
  uploads_today: number
  uploads_failed_today: number
  orphaned_files: number
  replay_pending: number
  replay_completed_today: number
  replay_completed_today_size: number
}

export interface ActivityItem {
  type:
    | 'session_completed'
    | 'session_interrupted'
    | 'upload_success'
    | 'upload_failed'
    | 'transcode_completed'
    | 'transcode_failed'
    | 'replay_completed'
    | 'replay_failed'
  title: string
  detail: string
  timestamp: string
  link: string | null
}

// ====== 全局设置 ======

export interface SettingItem {
  key: string
  value: string
  updated_at: string
}

// ====== 日志 ======

export interface LogFile {
  name: string
}
