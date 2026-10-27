/**
 * 判定录制进程退出是否属于「非预期退出」。
 *
 * 判定依据不是「有没有文件」，而是退出原因：
 * - 人工停止链路（`stopRecordingProcess` 已打 `_manualStopped` 标记，含 10s 超时兜底 SIGKILL）
 *   一律视为正常结束；
 * - 正常终止信号 SIGTERM、退出码 0 且无信号，视为正常结束；
 * - 其余情况（非零退出码、外部 SIGKILL、崩溃等）均为非预期退出。
 *
 * 非预期退出的会话与有效文件写入 `interrupted`，跳过即时转码，等待 delay 窗口后
 * 由看门狗 `finalizeInterruptedSessions()` 延迟完成；人工停止与正常退出走 `completed`。
 *
 * @param {Object} params
 * @param {number|null} params.code - 进程退出码（被信号终止时为 null）
 * @param {string|null} params.signal - 终止信号（正常退出时为 null）
 * @param {boolean} [params.isManualStop=false] - 是否由人工停止流程发起
 * @returns {boolean} true 表示非预期退出
 */
function isUnexpectedExit({ code, signal, isManualStop = false }) {
  if (isManualStop) return false; // 主动停止链路（含超时 SIGKILL）均属正常
  if (signal === 'SIGTERM') return false; // 正常终止信号
  if (code === 0 && signal === null) return false; // 进程正常退出
  return true; // 其余非零退出码、外部 SIGKILL、崩溃等均为意外退出
}

module.exports = { isUnexpectedExit };
