-- rollback_danmaku_fields.sql
-- 回滚脚本：恢复 recording_files 表中被移除的弹幕相关字段
-- 用途：如 Phase 3 数据库解耦发布后发现回滚需求，手动执行此脚本
-- 执行方式：psql -d <database> -f rollback_danmaku_fields.sql

-- 恢复 danmaku_ass_path 字段
ALTER TABLE recording_files ADD COLUMN IF NOT EXISTS danmaku_ass_path VARCHAR(1024) DEFAULT '';

-- 恢复索引（如之前存在）
-- CREATE INDEX IF NOT EXISTS idx_recording_files_danmaku_ass_path
--   ON recording_files(danmaku_ass_path) WHERE danmaku_ass_path != '';
