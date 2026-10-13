/**
 * 锁定 replay_cron sidecar 的启动安全性。
 *
 * cron-entrypoint.sh 在 `set -eu` 下运行：只要裸引用了一个 compose 没给默认值的环境变量，
 * 整个 sidecar 就启动即崩，回放/同步定时任务会跟着一起停摆。这是本目录唯一能让生产
 * 「静默什么都不干」的失败模式，所以把它锁进测试，而不是靠人工检查。
 */
const fs = require('fs');
const path = require('path');

const ENTRYPOINT = path.join(__dirname, '..', 'scripts', 'cron-entrypoint.sh');
const COMPOSE = path.join(__dirname, '..', 'docker', 'docker-compose.cron.yml');
const BACKUP_SCRIPT = path.join(__dirname, '..', 'scripts', 'backup-db.sh');

const entrypoint = fs.readFileSync(ENTRYPOINT, 'utf8');
const compose = fs.readFileSync(COMPOSE, 'utf8');
const backupScript = fs.readFileSync(BACKUP_SCRIPT, 'utf8');

// 注释里的示例（例如 `${VAR:-}`）不参与判定，否则会掩盖真实的裸引用
function code(script) {
  return script
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

// compose environment: 块里「带 :- 默认值」的键（`${VAR:-}` 空默认值同样算，set -u 下不会崩）
const defaultedComposeKeys = new Set(
  [...code(compose).matchAll(/^[ \t]+([A-Z][A-Z0-9_]*): \$\{[A-Z][A-Z0-9_]*:-[^}]*\}/gm)].map((m) => m[1])
);

// `$VAR` 与 `${VAR}` / `${VAR:-默认}` 都要认，漏掉裸引用等于这个测试白写
function references(script) {
  return [...script.matchAll(/\$(?:\{([A-Z][A-Z0-9_]*)(?::?-[^}]*)?\}|([A-Z][A-Z0-9_]*))/g)].map((m) => m[1] || m[2]);
}

// 引用处自带 `${VAR:-默认}`，set -u 崩不了
function inlineDefaults(script) {
  return new Set([...script.matchAll(/\$\{([A-Z][A-Z0-9_]*):?-[^}]*\}/g)].map((m) => m[1]));
}

// 脚本内部赋值的变量不是环境依赖
function localAssignments(script) {
  return new Set([...script.matchAll(/^[ \t]*(?:export )?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
}

function envDeps(script) {
  const src = code(script);
  const locals = localAssignments(src);
  const own = inlineDefaults(src);
  return [...new Set(references(src))].filter((name) => !locals.has(name) && !own.has(name));
}

describe('replay_cron sidecar 启动默认值', () => {
  it('entrypoint 裸引用的每个环境变量都在 compose 里带 :- 默认值', () => {
    const deps = envDeps(entrypoint);
    // 先确认分析器确实识别出了依赖：空集合说明正则退化，测试会变成摆设
    expect(deps.length).toBeGreaterThan(0);
    expect(deps).toEqual(expect.arrayContaining(['REPLAY_CRON_EXPR', 'SYNC_CRON_EXPR', 'REDIS_URL']));
    // 新增的 BACKUP_* 走内联默认值，不应以裸引用形式出现在依赖里
    expect(deps).not.toEqual(expect.arrayContaining(['BACKUP_CRON_ENABLED', 'BACKUP_CRON_EXPR']));
    const missing = deps.filter((name) => !defaultedComposeKeys.has(name));
    expect(missing).toEqual([]);
  });

  it('entrypoint 对 BACKUP_* 额外提供了内联兜底（compose 是第一道，这里是第二道）', () => {
    expect(entrypoint).toContain('${BACKUP_CRON_ENABLED:-false}');
    expect(entrypoint).toContain('${BACKUP_CRON_EXPR:-30 2 * * *}');
  });

  it('entrypoint 与 compose 的 BACKUP_* 默认值一致', () => {
    const pairs = [
      ['BACKUP_CRON_ENABLED', 'false'],
      ['BACKUP_CRON_EXPR', '30 2 * * *'],
      ['BACKUP_RETENTION_DAYS', '7'],
      ['BACKUP_OUTPUT_DIR', '/data/db_backups'],
    ];
    for (const [key, value] of pairs) {
      expect(compose).toEqual(expect.stringContaining(`${key}: \${${key}:-${value}}`));
    }
  });

  it('backup-db.sh 不裸引用环境变量，缺省时自带兜底或硬失败', () => {
    expect(envDeps(backupScript)).toEqual([]);
    expect(backupScript).toContain('DATABASE_URL="${DATABASE_URL:?');
  });

  it('备份产物目录以 rw 挂载，且容器路径与 BACKUP_OUTPUT_DIR 默认值一致', () => {
    const mount = compose.match(/- \$\{DB_BACKUP_HOST_DIR:-[^}]+\}:(\/[^:]+):(\w+)/);
    expect(mount).not.toBeNull();
    expect(mount[1]).toBe('/data/db_backups');
    expect(mount[2]).toBe('rw');
  });

  it('sidecar 镜像里没有 bash，备份脚本必须是 POSIX sh 入口', () => {
    // Dockerfile.replay-cron 是 alpine + postgresql17-client + curl，无 bash
    expect(backupScript.startsWith('#!/bin/sh')).toBe(true);
    expect(backupScript).toContain('set -eu');
  });
});
