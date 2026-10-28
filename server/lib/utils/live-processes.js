/**
 * 录制进程登记表（`recording_sessions.id` ↔ 子进程对象）。
 *
 * 用途：让「人工/看门狗主动停止」链路能在发信号之前，把 `_manualStopped` 标记写到
 * 真实的进程对象上。`RecorderService` 的 close 回调读取该标记，将停止判定为
 * 正常结束（completed），即使 FFmpeg 未响应 SIGTERM、最终被兜底 SIGKILL。
 *
 * 之所以独立成模块：RoomService / watchdog 都只需要「按 pid 或 sessionId 找进程并打标记」，
 * 不应为此实例化 RecordingManager（其构造器会启动定时器）。
 *
 * 进程在 `close`/`exit` 后由登记方或本模块的清理钩子移除；跨进程重启后登记表为空，
 * 此时调用方回退到直接按 pid 发信号（SIGTERM 仍按正常终止判定）。
 */
const bySession = new Map();
const sessionByProcess = new WeakMap();

/**
 * 登记一个录制子进程
 * @param {Object} params
 * @param {string|number|null} [params.sessionId] - 会话 ID（缺失时仍登记进程，供 pid 查找）
 * @param {import('child_process').ChildProcess} params.process - 子进程对象
 */
function register({ sessionId, process: proc }) {
  if (!proc) return;
  if (sessionId !== null && sessionId !== undefined) {
    bySession.set(String(sessionId), proc);
    sessionByProcess.set(proc, String(sessionId));
  }
  // close 后自动注销，避免登记表持有已退出进程
  if (typeof proc.once === 'function') {
    proc.once('close', () => unregister({ sessionId, process: proc }));
  }
}

/**
 * 注销进程登记
 * @param {Object} params
 * @param {string|number|null} [params.sessionId]
 * @param {import('child_process').ChildProcess} [params.process]
 */
function unregister({ sessionId, process: proc }) {
  const sid = sessionId !== null && sessionId !== undefined ? String(sessionId) : sessionByProcess.get(proc);
  if (sid !== undefined && bySession.get(sid) === proc) {
    bySession.delete(sid);
  }
  if (proc) sessionByProcess.delete(proc);
}

/**
 * 查找仍在运行的登记进程
 * @param {Object} params
 * @param {string|number|null} [params.sessionId]
 * @param {number|null} [params.pid]
 * @returns {import('child_process').ChildProcess|null}
 */
function find({ sessionId, pid } = {}) {
  if (sessionId !== null && sessionId !== undefined) {
    const proc = bySession.get(String(sessionId));
    if (proc && proc.exitCode === null && !proc.killed) return proc;
  }
  if (pid) {
    for (const proc of bySession.values()) {
      if (proc.pid === pid && proc.exitCode === null && !proc.killed) return proc;
    }
  }
  return null;
}

/**
 * 将进程标记为「人工/主动停止」，使 close 回调按 completed 处理
 * @param {Object} params
 * @param {string|number|null} [params.sessionId]
 * @param {number|null} [params.pid]
 * @param {import('child_process').ChildProcess} [params.process] - 已知进程对象时直接使用
 * @returns {import('child_process').ChildProcess|null} 命中的进程（未登记时为 null）
 */
function markManualStop({ sessionId, pid, process: known } = {}) {
  const proc = known || find({ sessionId, pid });
  if (proc) proc._manualStopped = true;
  return proc || null;
}

/**
 * 清空登记表（仅测试使用）
 */
function _reset() {
  bySession.clear();
}

module.exports = { register, unregister, find, markManualStop, _reset };
