#!/usr/bin/env node

require('../config/env').initEnv();

const redis = require('../db/redis');
const KuaishouChecker = require('../lib/core/polling/KuaishouAPIChecker');

const KUAISHOU_GLOBAL_INTERVAL_SECONDS = 10;

const TARGETS = [
  {
    name: 'KSGJuHao',
    url: 'https://live.kuaishou.com/u/KSGJuHao',
    expectedName: 'KSG句号',
  },
  {
    name: 'KPL704668133',
    url: 'https://live.kuaishou.com/u/KPL704668133',
    expectedName: 'KPL王者荣耀职业联赛',
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactUrl(url) {
  return KuaishouChecker.redactUrl(url);
}

async function checkTarget(target) {
  const startedAt = new Date();
  const checker = new KuaishouChecker(target.url);
  const principalId = checker.getRoomKey();

  try {
    const result = await checker.checkStatus();
    return {
      target: target.name,
      principalId,
      startedAt: startedAt.toISOString(),
      status: 'ok',
      isLive: result.isLive,
      roomName: result.roomName,
      streamUrl: redactUrl(result.streamUrl),
      streamInfo: result.streamInfo,
    };
  } catch (err) {
    return {
      target: target.name,
      principalId,
      startedAt: startedAt.toISOString(),
      status: 'unknown',
      error: err.message,
    };
  }
}

async function runRound(round, globalIntervalSeconds) {
  console.log(`\n[kuaishou-smoke] round=${round}`);
  const results = [];

  for (let index = 0; index < TARGETS.length; index += 1) {
    const target = TARGETS[index];
    const result = await checkTarget(target);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));

    if (index < TARGETS.length - 1) {
      await sleep(globalIntervalSeconds * 1000);
    }
  }

  return results;
}

async function main() {
  const rounds = parseInt(process.env.KUAISHOU_SMOKE_ROUNDS || '2', 10);
  const intervalSeconds = parseInt(process.env.KUAISHOU_SMOKE_INTERVAL_SECONDS || '70', 10);
  const globalIntervalSeconds = KUAISHOU_GLOBAL_INTERVAL_SECONDS;

  console.log('[kuaishou-smoke] mode=direct-api');
  console.log(
    `[kuaishou-smoke] rounds=${rounds} interval=${intervalSeconds}s globalInterval=${globalIntervalSeconds}s`
  );
  console.log(`[kuaishou-smoke] timeoutMs=${process.env.KUAISHOU_API_TIMEOUT_MS || '15000'}`);

  for (let round = 1; round <= rounds; round += 1) {
    await runRound(round, globalIntervalSeconds);
    if (round < rounds) {
      await sleep(intervalSeconds * 1000);
    }
  }
}

main()
  .catch((err) => {
    console.error('[kuaishou-smoke] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await redis.disconnect().catch(() => {});
  });
