const { isRetry, RETRY_TIMEOUT_MS } = require('./heartbeat-parser');

const heartbeatMap = new Map();

function updateHeartbeat(roomKey, chunk) {
  const now = Date.now();
  const existing = heartbeatMap.get(roomKey) || { lastHeartbeatAt: now, retryStartAt: null };
  existing.lastHeartbeatAt = now;

  if (chunk && isRetry(chunk)) {
    if (!existing.retryStartAt) {
      existing.retryStartAt = now;
      existing.retryWarned = false;
    } else if (now - existing.retryStartAt > RETRY_TIMEOUT_MS && !existing.retryWarned) {
      existing.retryWarned = true;
      console.warn(`[心跳] ${roomKey} stream-gears 重试超过 ${RETRY_TIMEOUT_MS / 1000}s，链路可能已死`);
    }
  } else {
    existing.retryStartAt = null;
    existing.retryWarned = false;
  }

  heartbeatMap.set(roomKey, existing);
}

function getHeartbeatInfo(roomKey) {
  const info = heartbeatMap.get(roomKey);
  if (!info) return null;
  const now = Date.now();
  return {
    lastHeartbeatAt: info.lastHeartbeatAt,
    age: now - info.lastHeartbeatAt,
    inRetryLoop: info.retryStartAt !== null,
    retryDuration: info.retryStartAt ? now - info.retryStartAt : 0,
    shouldReconnect: info.retryStartAt !== null && now - info.retryStartAt > RETRY_TIMEOUT_MS,
  };
}

function clearHeartbeat(roomKey) {
  heartbeatMap.delete(roomKey);
}

module.exports = { updateHeartbeat, getHeartbeatInfo, clearHeartbeat };
