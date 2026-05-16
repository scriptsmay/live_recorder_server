const FFmpegHeartbeat = /frame=\d+\s+fps=[\d.]+\s+bitrate=[\d.]+kbits/;
const StreamGearsHeartbeat = /download speed|retry|flv tag/i;
const RetryPattern = /retry/i;
const RETRY_TIMEOUT_MS = 3 * 60 * 1000;

function parseHeartbeat(chunk) {
  const text = chunk.toString();
  return FFmpegHeartbeat.test(text) || StreamGearsHeartbeat.test(text);
}

function isRetry(chunk) {
  return RetryPattern.test(chunk.toString());
}

module.exports = { parseHeartbeat, isRetry, RETRY_TIMEOUT_MS };
