const axios = require('axios');

const WEBHOOK_URL = process.env.MESSAGE_FEISHU_WEBHOOK;

async function send(title, content) {
  if (!WEBHOOK_URL) return;
  const text = `${title}\n${content}\n${new Date().toLocaleString('zh-CN')}`;
  try {
    await axios.post(
      WEBHOOK_URL,
      {
        msg_type: 'text',
        content: { text },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
    );
  } catch (err) {
    console.error('[notify] 发送失败:', err.message);
  }
}

async function shouldNotify(roomUrl) {
  if (!roomUrl) return true;
  try {
    const pool = require('../db/index');
    const r = await pool.query(
      'SELECT notification_enabled FROM rooms WHERE room_url = $1',
      [roomUrl]
    );
    return r.rows.length === 0 || r.rows[0].notification_enabled !== false;
  } catch (_) {
    return true;
  }
}

async function recordingStart(roomName, caption, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    '🎬 开始录制',
    `直播间：${roomName || '未知'}${caption ? '\n标题：' + caption : ''}`
  );
}

async function recordingComplete(
  roomName,
  fileCount,
  totalMB,
  sessionId,
  roomUrl
) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    '✅ 录制完成',
    `直播间：${roomName || '未知'}\n文件：${fileCount} 段\n大小：${totalMB} MB\n会话ID：${sessionId}`
  );
}

async function uploadStart(roomName, tmplName, fileCount, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    '📤 开始投稿',
    `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n文件：${fileCount} 个`
  );
}

async function uploadComplete(roomName, title, bvId, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    '✅ 投稿完成',
    `直播间：${roomName || '未知'}\n标题：${title || '未知'}\nBV号：${bvId || '无'}`
  );
}

module.exports = {
  send,
  recordingStart,
  recordingComplete,
  uploadStart,
  uploadComplete,
};
