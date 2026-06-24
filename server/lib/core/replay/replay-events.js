const redis = require('../../../db/redis');

function buildReplayEvent(type, record, extra = {}) {
  return {
    type,
    record_id: record.id,
    replay_id: record.replay_id,
    principal_id: record.principal_id,
    status: record.status,
    timestamp: Date.now(),
    ...extra,
  };
}

async function publishReplayEvent(type, record, extra = {}) {
  const channel = process.env.REDIS_PUBLISH_CHANNEL;
  if (!channel || !record) return false;

  await redis.publish(channel, JSON.stringify(buildReplayEvent(type, record, extra)));
  return true;
}

function publishReplayEventFireAndForget(type, record, extra = {}) {
  publishReplayEvent(type, record, extra).catch(() => {});
}

module.exports = {
  buildReplayEvent,
  publishReplayEvent,
  publishReplayEventFireAndForget,
};
