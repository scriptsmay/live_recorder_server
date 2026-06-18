#!/usr/bin/env node

require('../server/config/env').initEnv();

const KuaishouChecker = require('../server/lib/core/polling/KuaishouChecker');

const KUAISHOU_GLOBAL_INTERVAL_SECONDS = 20;
const KUAISHOU_SMOKE_ROUNDS = parseInt(process.env.KUAISHOU_SMOKE_ROUNDS || '2', 10);
const KUAISHOU_SMOKE_INTERVAL_SECONDS = parseInt(process.env.KUAISHOU_SMOKE_INTERVAL_SECONDS || '70', 10);

const TARGETS = [
  {
    name: 'KPL704668133',
    url: 'https://live.kuaishou.com/u/KPL704668133',
    expectedName: 'KPL王者荣耀职业联赛',
  },
  // {
  //   name: 'KSGJuHao',
  //   url: 'https://live.kuaishou.com/u/KSGJuHao',
  //   expectedName: 'KSG句号',
  // },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkTarget(target) {
  const startedAt = new Date();
  const checker = new KuaishouChecker(target.url);

  try {
    const result = await checker.checkStatus();
    return {
      target: target.name,
      startedAt: startedAt.toISOString(),
      status: 'ok',
      isLive: result.isLive,
      roomName: result.roomName,
      streamUrl: KuaishouChecker.redactUrl(result.streamUrl),
      streamInfo: result.streamInfo,
    };
  } catch (err) {
    return {
      target: target.name,
      startedAt: startedAt.toISOString(),
      status: 'error',
      error: err.message,
    };
  }
}

async function runRound(round) {
  console.log(`\n[kuaishou-smoke] round=${round}`);
  const results = [];

  for (let index = 0; index < TARGETS.length; index += 1) {
    const target = TARGETS[index];
    const result = await checkTarget(target);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));

    if (index < TARGETS.length - 1) {
      await sleep(KUAISHOU_GLOBAL_INTERVAL_SECONDS * 1000);
    }
  }

  return results;
}

async function main() {
  console.log(`[kuaishou-smoke] rounds=${KUAISHOU_SMOKE_ROUNDS} interval=${KUAISHOU_SMOKE_INTERVAL_SECONDS}s`);
  console.log('[kuaishou-smoke] method=http-get-extract-state');

  for (let round = 1; round <= KUAISHOU_SMOKE_ROUNDS; round += 1) {
    await runRound(round);
    if (round < KUAISHOU_SMOKE_ROUNDS) {
      await sleep(KUAISHOU_SMOKE_INTERVAL_SECONDS * 1000);
    }
  }
}

main()
  .catch((err) => {
    console.error('[kuaishou-smoke] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode || 0);
  });
