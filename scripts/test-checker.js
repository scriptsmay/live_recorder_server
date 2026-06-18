#!/usr/bin/env node

/**
 * Universal Checker Test Script
 *
 * Standalone test script for verifying live stream status checks
 * across all supported platforms.
 *
 * Usage:
 *   node scripts/test-checker.js <room_url>
 *   node scripts/test-checker.js --all
 *   node scripts/test-checker.js --platform <platform_id>
 *
 * Examples:
 *   node scripts/test-checker.js https://www.douyu.com/67890
 *   node scripts/test-checker.js https://www.huya.com/someanchor
 *   node scripts/test-checker.js https://live.douyin.com/123456
 *   node scripts/test-checker.js https://live.kuaishou.com/u/SomeUser
 *   node scripts/test-checker.js --all
 *   node scripts/test-checker.js --platform kuaishou
 */

'use strict';

require('../server/config/env').initEnv();

const { detectPlatform } = require('../server/lib/utils/platform-detector');
const checkers = require('../server/lib/core/polling/checkers');
const PlatformChecker = require('../server/lib/core/polling/PlatformChecker');
const KuaishouChecker = require('../server/lib/core/polling/KuaishouChecker');

// ─── ANSI colors ───────────────────────────────────────────────────────────────

const color = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function c(text, ...codes) {
  return codes.join('') + text + color.reset;
}

// ─── Sample URLs for --all mode ────────────────────────────────────────────────

const SAMPLE_URLS = {
  bilibili: 'https://live.bilibili.com/1',
  douyu: 'https://www.douyu.com/36252',
  huya: 'https://www.huya.com/kaerlol',
  douyin: 'https://live.douyin.com/61204923995',
  kuaishou: 'https://live.kuaishou.com/u/KPL704668133',
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function redactStreamUrl(url) {
  if (!url) return url;
  return url.replace(
    /([?&](txSecret|hwSecret|wsSecret|stat|token|sign|sig|wsTime|txTime|fm|sv|p2p|content-id|report|HotKey|sn)=)[^&]+/gi,
    '$1<redacted>'
  );
}

function truncate(str, maxLen = 120) {
  if (!str || typeof str !== 'string') return str;
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

function resolveChecker(url) {
  // Try platform-detector first
  const platformId = detectPlatform(url);
  if (platformId && checkers[platformId]) {
    return { platformId, CheckerClass: checkers[platformId] };
  }

  // Fallback: ask each checker's canHandleUrl
  for (const [id, CheckerClass] of Object.entries(checkers)) {
    if (CheckerClass.canHandleUrl && CheckerClass.canHandleUrl(url)) {
      return { platformId: id, CheckerClass };
    }
  }

  return null;
}

// ─── Core test function ────────────────────────────────────────────────────────

async function testUrl(url, verbose = false) {
  const resolved = resolveChecker(url);

  if (!resolved) {
    console.log(c(`\n  [ERROR] `, color.red, color.bold) + `No checker found for URL: ${url}`);
    console.log(c(`  Supported platforms: `, color.dim) + Object.keys(checkers).join(', '));
    return { url, success: false, error: 'No matching checker' };
  }

  const { platformId, CheckerClass } = resolved;

  console.log(c(`\n${'='.repeat(72)}`, color.dim));
  console.log(c(`  Platform: `, color.bold) + c(platformId, color.cyan));
  console.log(c(`  URL:      `, color.bold) + url);
  console.log(c(`${'='.repeat(72)}`, color.dim));

  const checker = new CheckerClass(url);
  const startTime = Date.now();

  // Debug: fetch raw API responses if verbose
  let debugData = {};
  if (verbose && platformId === 'kuaishou') {
    try {
      const roomKey = KuaishouChecker.extractPrincipalId(url);
      console.log(c(`\n  [DEBUG] Room Key: `, color.magenta) + roomKey);

      // Fetch livedetail
      console.log(c(`  [DEBUG] Fetching livedetail...`, color.magenta));
      const livedetailUrl = `https://live.kuaishou.com/live_api/liveroom/livedetail?principalId=${roomKey}`;
      console.log(c(`  [DEBUG] URL: `, color.gray) + livedetailUrl);

      const livedetailResponse = await PlatformChecker.fetchJson(livedetailUrl, {
        timeout: 15000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          Accept: 'application/json',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: 'https://live.kuaishou.com/',
          Origin: 'https://live.kuaishou.com',
        },
      });

      debugData.livedetail = livedetailResponse;
      console.log(c(`  [DEBUG] Livedetail Response:`, color.magenta));
      console.log(c(JSON.stringify(livedetailResponse, null, 2), color.gray));

      // Analyze livedetail structure
      const data = livedetailResponse?.data || livedetailResponse || {};
      const author = data.author || {};
      const liveStream = data.liveStream || {};

      console.log(c(`\n  [DEBUG] Analysis:`, color.magenta));
      console.log(c(`    author.living: `, color.gray) + author.living);
      console.log(c(`    data.living: `, color.gray) + data.living);
      console.log(c(`    liveStream.living: `, color.gray) + liveStream.living);
      console.log(c(`    data.result: `, color.gray) + data.result);
      console.log(c(`    liveStream.playUrls: `, color.gray) + (liveStream.playUrls ? 'exists' : 'null'));
      console.log(c(`    liveStream.playUrls.h264: `, color.gray) + (liveStream.playUrls?.h264 ? 'exists' : 'null'));
      console.log(c(`    liveStream.playUrls.hevc: `, color.gray) + (liveStream.playUrls?.hevc ? 'exists' : 'null'));

      if (liveStream.playUrls?.h264?.adaptationSet?.representation) {
        const reps = liveStream.playUrls.h264.adaptationSet.representation;
        console.log(c(`    h264 representations count: `, color.gray) + reps.length);
        reps.forEach((rep, i) => {
          console.log(
            c(`    h264[${i}]: `, color.gray) +
              `url=${rep.url ? 'exists' : 'null'}, hidden=${rep.hidden}, bitrate=${rep.bitrate}`
          );
        });
      }

      // Try profile/public as fallback
      console.log(c(`\n  [DEBUG] Fetching profile/public...`, color.magenta));
      const profileUrl = `https://live.kuaishou.com/live_api/profile/public?principalId=${roomKey}`;
      console.log(c(`  [DEBUG] URL: `, color.gray) + profileUrl);

      const profileResponse = await PlatformChecker.fetchJson(profileUrl, {
        timeout: 15000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          Accept: 'application/json',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: 'https://live.kuaishou.com/',
          Origin: 'https://live.kuaishou.com',
        },
      });

      debugData.profile = profileResponse;
      console.log(c(`  [DEBUG] Profile Response:`, color.magenta));
      console.log(c(JSON.stringify(profileResponse, null, 2), color.gray));

      // Analyze profile structure
      const profileData = profileResponse?.data || profileResponse || {};
      const profileLive = profileData.live || {};
      const profileAuthor = profileLive.author || profileData.author || {};

      console.log(c(`\n  [DEBUG] Profile Analysis:`, color.magenta));
      console.log(c(`    profileLive.living: `, color.gray) + profileLive.living);
      console.log(c(`    profileAuthor.living: `, color.gray) + profileAuthor.living);
      console.log(c(`    profileData.living: `, color.gray) + profileData.living);
      console.log(c(`    profileData.result: `, color.gray) + profileData.result);
    } catch (debugErr) {
      console.log(c(`  [DEBUG] Error: `, color.red) + debugErr.message);
      debugData.error = debugErr.message;
    }
  }

  try {
    const result = await checker.checkStatus();
    const elapsed = Date.now() - startTime;

    // Status indicator
    const statusIcon = result.error
      ? c('ERROR', color.red, color.bold)
      : result.isLive
        ? c('LIVE', color.green, color.bold)
        : c('OFFLINE', color.yellow, color.bold);

    console.log(`\n  Status:     ${statusIcon}`);
    console.log(c(`  Duration:   `, color.dim) + formatDuration(elapsed));
    console.log(c(`  Room Name:  `, color.dim) + (result.roomName || c('(empty)', color.gray)));
    console.log(c(`  Room Title: `, color.dim) + (result.roomTitle || c('(empty)', color.gray)));

    if (result.roomCover) {
      console.log(c(`  Room Cover: `, color.dim) + truncate(result.roomCover, 80));
    }

    if (result.isLive && result.streamUrl) {
      console.log(c(`  Stream URL: `, color.dim) + truncate(redactStreamUrl(result.streamUrl), 100));
    }

    if (result.streamInfo) {
      console.log(c(`  Stream Info:`, color.dim));
      for (const [key, value] of Object.entries(result.streamInfo)) {
        console.log(c(`    ${key}: `, color.gray) + value);
      }
    }

    if (result.recordable === false) {
      console.log(c(`  Recordable: `, color.dim) + c('No', color.red));
    }

    if (result.error) {
      console.log(c(`  Error:      `, color.dim) + c(result.error, color.red));
    }

    return {
      url,
      platformId,
      success: true,
      elapsed,
      result: {
        ...result,
        streamUrl: redactStreamUrl(result.streamUrl),
      },
      debugData,
    };
  } catch (err) {
    const elapsed = Date.now() - startTime;

    console.log(`\n  Status:     ${c('EXCEPTION', color.red, color.bold)}`);
    console.log(c(`  Duration:   `, color.dim) + formatDuration(elapsed));
    console.log(c(`  Error:      `, color.dim) + c(err.message, color.red));

    if (process.env.DEBUG) {
      console.log(c(`  Stack:`, color.dim));
      console.log(c(err.stack, color.gray));
    }

    return {
      url,
      platformId,
      success: false,
      elapsed,
      error: err.message,
      debugData,
    };
  }
}

// ─── Summary reporter ──────────────────────────────────────────────────────────

function printSummary(results) {
  console.log(c(`\n${'='.repeat(72)}`, color.dim));
  console.log(c(`  Summary`, color.bold));
  console.log(c(`${'='.repeat(72)}`, color.dim));

  const total = results.length;
  const succeeded = results.filter((r) => r.success).length;
  const failed = total - succeeded;

  console.log(
    c(`  Total: `, color.dim) +
      `${total}  ` +
      c(`Passed: `, color.dim) +
      c(succeeded, color.green) +
      `  ` +
      c(`Failed: `, color.dim) +
      c(failed, failed > 0 ? color.red : color.dim)
  );

  console.log('');
  for (const r of results) {
    const icon = r.success
      ? r.result?.error
        ? c('WARN', color.yellow)
        : c(' OK ', color.green)
      : c('FAIL', color.red);

    const platform = r.platformId || 'unknown';
    const duration = r.elapsed ? formatDuration(r.elapsed) : '-';
    const note = r.success ? (r.result?.isLive ? 'LIVE' : 'offline') : r.error || 'failed';

    console.log(`  [${icon}] ${c(platform.padEnd(10), color.cyan)} ${duration.padEnd(10)} ${note}`);
  }

  console.log('');
}

// ─── CLI parsing ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { urls: [], all: false, platform: null, verbose: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--all' || arg === '-a') {
      opts.all = true;
    } else if (arg === '--platform' || arg === '-p') {
      opts.platform = args[++i];
    } else if (arg === '--verbose' || arg === '-v') {
      opts.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      opts.urls.push(arg);
    }
  }

  return opts;
}

function printUsage() {
  console.log(`
${c('Universal Checker Test Script', color.bold)}

${c('Usage:', color.bold)}
  node scripts/test-checker.js <room_url> [room_url2 ...]
  node scripts/test-checker.js --all
  node scripts/test-checker.js --platform <platform_id>

${c('Options:', color.bold)}
  --all, -a          Test all supported platforms with sample URLs
  --platform, -p     Test a specific platform with its sample URL
  --verbose, -v      Show detailed API responses and debug info
  --help, -h         Show this help message

${c('Environment:', color.bold)}
  DEBUG=1            Show full stack traces on errors

${c('Supported Platforms:', color.bold)}
  ${Object.keys(checkers).join(', ')}

${c('Examples:', color.bold)}
  node scripts/test-checker.js https://live.kuaishou.com/u/KPL704668133
  node scripts/test-checker.js --platform kuaishou --verbose
  node scripts/test-checker.js --all
  node scripts/test-checker.js --platform kuaishou
  DEBUG=1 node scripts/test-checker.js https://live.douyin.com/123456
`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  let urls = opts.urls;

  if (opts.all) {
    urls = Object.values(SAMPLE_URLS);
  } else if (opts.platform) {
    const sampleUrl = SAMPLE_URLS[opts.platform];
    if (!sampleUrl) {
      console.error(
        c(`[ERROR] Unknown platform: ${opts.platform}`, color.red) +
          `\n  Available: ${Object.keys(SAMPLE_URLS).join(', ')}`
      );
      process.exitCode = 1;
      return;
    }
    urls = [sampleUrl];
  }

  if (urls.length === 0) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  console.log(c(`\n[Checker Test] `, color.bold) + `Testing ${urls.length} URL(s)...`);
  if (opts.verbose) {
    console.log(c(`[Checker Test] `, color.magenta) + `Verbose mode enabled`);
  }

  const results = [];
  for (const url of urls) {
    const result = await testUrl(url, opts.verbose);
    results.push(result);
  }

  printSummary(results);

  const hasFailure = results.some((r) => !r.success);
  if (hasFailure) {
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit())
  .catch((err) => {
    console.error(c(`[test-checker] Fatal error: ${err.message}`, color.red));
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  });
