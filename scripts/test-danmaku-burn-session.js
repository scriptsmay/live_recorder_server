#!/usr/bin/env node

'use strict';

/**
 * 弹幕压制测试脚本
 *
 * 用法:
 *   NODE_ENV=development node scripts/test-danmaku-burn-session.js 22 --normalize-start
 *   NODE_ENV=development node scripts/test-danmaku-burn-session.js 22 --segment-id 154 --offset-ms -52966
 */

require('../server/config/env').initEnv();

const fs = require('fs');
const path = require('path');
const pool = require('../server/db');
const danmakuAssGenerator = require('../server/lib/core/danmaku/DanmakuAssGenerator');
const danmakuBurner = require('../server/lib/core/danmaku-burner');

const projectRoot = path.join(__dirname, '..');

function printUsage() {
  console.log(`用法:
  NODE_ENV=development node scripts/test-danmaku-burn-session.js <sessionId> [options]

Options:
  --segment-id <id>       指定 recording_files.id，默认取该 session 的第一个分段
  --normalize-start       减去 JSONL 中首条 comment 的 ts_ms，让测试弹幕从 0 秒附近开始
  --offset-ms <ms>        额外时间偏移，正值延后，负值提前；可与 --normalize-start 叠加
  --output <path>         指定输出 mp4，默认写到输入视频旁边
  --video-width <px>      ASS PlayResX，默认 1920
  --video-height <px>     ASS PlayResY，默认 1080
  --fps <24-60>           压制输出帧率，默认 30
  --no-force              输出文件存在时不覆盖
  --help                  显示帮助
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    sessionId: null,
    segmentId: null,
    normalizeStart: false,
    offsetMs: 0,
    outputPath: null,
    videoWidth: 1920,
    videoHeight: 1080,
    fps: 30,
    force: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--segment-id') {
      options.segmentId = parsePositiveInt(args[++i], '--segment-id');
    } else if (arg === '--normalize-start') {
      options.normalizeStart = true;
    } else if (arg === '--offset-ms') {
      options.offsetMs = parseInteger(args[++i], '--offset-ms');
    } else if (arg === '--output') {
      options.outputPath = args[++i] || null;
    } else if (arg === '--video-width') {
      options.videoWidth = parsePositiveInt(args[++i], '--video-width');
    } else if (arg === '--video-height') {
      options.videoHeight = parsePositiveInt(args[++i], '--video-height');
    } else if (arg === '--fps') {
      options.fps = parsePositiveInt(args[++i], '--fps');
    } else if (arg === '--no-force') {
      options.force = false;
    } else if (!options.sessionId && /^\d+$/.test(arg)) {
      options.sessionId = parsePositiveInt(arg, 'sessionId');
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  if (!options.sessionId) {
    printUsage();
    throw new Error('缺少 sessionId');
  }

  options.fps = Math.min(60, Math.max(24, options.fps));
  return options;
}

function parseInteger(value, name) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} 必须是整数`);
  return parsed;
}

function parsePositiveInt(value, name) {
  const parsed = parseInteger(value, name);
  if (parsed <= 0) throw new Error(`${name} 必须大于 0`);
  return parsed;
}

function resolveProjectPath(filePath) {
  if (!filePath) return filePath;
  return path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
}

function toStoredPath(filePath) {
  const relative = path.relative(projectRoot, filePath);
  return relative.startsWith('..') ? filePath : relative;
}

function makeOutputPath(inputPath, options) {
  if (options.outputPath) return resolveProjectPath(options.outputPath);

  const parsed = path.parse(inputPath);
  const suffix = options.normalizeStart ? '_danmaku_test_offset' : '_danmaku_test';
  return path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext || '.mp4'}`);
}

async function getSession(sessionId) {
  const result = await pool.query(`SELECT id, output_dir FROM recording_sessions WHERE id = $1`, [sessionId]);
  if (result.rows.length === 0) throw new Error(`会话不存在: ${sessionId}`);
  return result.rows[0];
}

async function getSegments(sessionId) {
  const result = await pool.query(
    `SELECT id, segment_index, segment_start_ms, segment_end_ms, file_path
     FROM recording_files
     WHERE session_id = $1
     ORDER BY id ASC`,
    [sessionId]
  );
  if (result.rows.length === 0) throw new Error(`会话没有 recording_files: ${sessionId}`);
  return result.rows;
}

async function getCommentMinTs(jsonlPath) {
  const events = await danmakuAssGenerator._readJsonl(jsonlPath);
  const timestamps = events.filter((event) => event.type === 'comment' && event.text).map((event) => event.ts_ms);
  if (timestamps.length === 0) throw new Error('JSONL 中没有 comment 弹幕');
  return Math.min(...timestamps);
}

function getSessionDurationMs(segments) {
  const ends = segments.map((segment) => Number(segment.segment_end_ms || 0)).filter((value) => value > 0);
  return ends.length > 0 ? Math.max(...ends) : null;
}

async function main() {
  const options = parseArgs(process.argv);
  process.env.DANMAKU_BURN_FPS = String(options.fps);

  const session = await getSession(options.sessionId);
  const segments = await getSegments(options.sessionId);
  const targetSegment =
    segments.find((segment) => segment.id === options.segmentId) || (options.segmentId ? null : segments[0]);
  if (!targetSegment) throw new Error(`分段不存在: ${options.segmentId}`);

  const sessionDir = resolveProjectPath(session.output_dir);
  const danmakuDir = path.join(sessionDir, 'danmaku');
  const jsonlPath = path.join(danmakuDir, 'danmaku.jsonl');
  const assPath = path.join(danmakuDir, 'danmaku.ass');
  const segmentOutputDir = path.join(danmakuDir, 'segments');
  const inputPath = resolveProjectPath(targetSegment.file_path);
  const outputPath = makeOutputPath(inputPath, options);

  if (!fs.existsSync(jsonlPath)) throw new Error(`JSONL 不存在: ${jsonlPath}`);
  if (!fs.existsSync(inputPath)) throw new Error(`视频不存在: ${inputPath}`);

  let offsetMs = options.offsetMs;
  let normalizedStartMs = null;
  if (options.normalizeStart) {
    normalizedStartMs = await getCommentMinTs(jsonlPath);
    offsetMs -= normalizedStartMs;
  }

  fs.mkdirSync(segmentOutputDir, { recursive: true });
  const durationMs = getSessionDurationMs(segments);

  console.log(
    `[danmaku-test] session=${options.sessionId} segment=${targetSegment.id} offsetMs=${offsetMs} fps=${options.fps}`
  );
  if (normalizedStartMs !== null) {
    console.log(`[danmaku-test] normalize-start: min ts_ms=${normalizedStartMs}`);
  }

  const sessionAss = await danmakuAssGenerator.generateFromJsonl({
    jsonlPath,
    assPath,
    videoWidth: options.videoWidth,
    videoHeight: options.videoHeight,
    durationMs,
    offsetMs,
  });
  if (!sessionAss.success) throw new Error(`会话 ASS 生成失败: ${sessionAss.error}`);

  const segmentAss = await danmakuAssGenerator.generateSegmentAss({
    jsonlPath,
    outputDir: segmentOutputDir,
    segments,
    videoWidth: options.videoWidth,
    videoHeight: options.videoHeight,
    offsetMs,
  });
  for (const segment of segmentAss) {
    await pool.query(`UPDATE recording_files SET danmaku_ass_path = $1 WHERE id = $2`, [
      toStoredPath(segment.assPath),
      segment.id,
    ]);
  }

  const targetAss = segmentAss.find((segment) => segment.id === targetSegment.id);
  if (!targetAss || targetAss.eventCount === 0) {
    throw new Error(`目标分段没有可压制弹幕: ${targetSegment.id}`);
  }

  const burnResult = await danmakuBurner.burn({
    inputPath,
    assPath: targetAss.assPath,
    outputPath,
    force: options.force,
    useQsv: false,
    sessionId: options.sessionId,
    segmentIndex: targetSegment.segment_index,
  });
  if (!burnResult.success) throw new Error(`压制失败: ${burnResult.error}`);

  console.log(
    JSON.stringify(
      {
        sessionId: options.sessionId,
        segmentId: targetSegment.id,
        offsetMs,
        normalizedStartMs,
        sessionAss,
        targetAss,
        outputPath: burnResult.outputPath,
        outputSize: burnResult.outputSize,
        logPath: burnResult.logPath,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(`[danmaku-test] ERROR: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
