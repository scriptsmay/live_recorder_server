#!/usr/bin/env node

require('../config/env').initEnv();

const KuaishouChecker = require('../lib/core/polling/KuaishouChecker');

const KUAISHOU_GLOBAL_INTERVAL_SECONDS = 20;
const KUAISHOU_SMOKE_ROUNDS = 2;
const KUAISHOU_SMOKE_INTERVAL_SECONDS = 121;

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

function redactUrl(url) {
  return KuaishouChecker.redactUrl(url);
}

async function checkTarget(target) {
  const startedAt = new Date();
  const checker = new KuaishouChecker(target.url);
  const principalId = checker.getRoomKey();
  const sessionKey = checker.getSessionKey(principalId);
  const hadSession = await checker.hasStoredSession(principalId);

  try {
    const result = await checker.checkStatus();
    const hasSession = await checker.hasStoredSession(principalId);
    return {
      target: target.name,
      principalId,
      sessionKey,
      hadSession,
      hasSession,
      startedAt: startedAt.toISOString(),
      status: 'ok',
      isLive: result.isLive,
      roomName: result.roomName,
      streamUrl: redactUrl(result.streamUrl),
      streamInfo: result.streamInfo,
    };
  } catch (err) {
    const hasSession = await checker.hasStoredSession(principalId);
    return {
      target: target.name,
      principalId,
      sessionKey,
      hadSession,
      hasSession,
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
  if (!process.env.REMOTE_BROWSER_WS_ENDPOINT) {
    console.error('REMOTE_BROWSER_WS_ENDPOINT is required');
    process.exitCode = 1;
    return;
  }

  const rounds = parseInt(KUAISHOU_SMOKE_ROUNDS || '2', 10);
  const intervalSeconds = parseInt(KUAISHOU_SMOKE_INTERVAL_SECONDS || '70', 10);
  const globalIntervalSeconds = KUAISHOU_GLOBAL_INTERVAL_SECONDS;

  console.log('[kuaishou-smoke] endpoint configured');
  console.log(
    `[kuaishou-smoke] rounds=${rounds} interval=${intervalSeconds}s globalInterval=${globalIntervalSeconds}s`
  );
  console.log('[kuaishou-smoke] sessionScope=platform simulateHuman=true');
  console.log(
    `[kuaishou-smoke] stealth=${process.env.KUAISHOU_CHECKER_STEALTH !== 'false'} allowFirstScreenResources=${
      process.env.KUAISHOU_CHECKER_ALLOW_FIRST_SCREEN_RESOURCES === 'true'
    }`
  );

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
  .finally(() => {
    process.exit(process.exitCode || 0);
  });
