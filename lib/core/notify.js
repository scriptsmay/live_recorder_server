const axios = require('axios');
const config = require('../../config/config');

async function sendFeishu(title, content, text) {
  const webhookUrl = config.MESSAGE_FEISHU_WEBHOOK || process.env.MESSAGE_FEISHU_WEBHOOK;
  if (!webhookUrl) return false;
  await axios.post(
    webhookUrl,
    {
      msg_type: 'text',
      content: { text },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
  );
  return true;
}

async function sendGotify(title, content) {
  const server = config.MESSAGE_GOTIFY_SERVER || process.env.MESSAGE_GOTIFY_SERVER;
  const token = config.MESSAGE_GOTIFY_TOKEN || process.env.MESSAGE_GOTIFY_TOKEN;
  if (!server || !token) return false;

  const priority = parseInt(config.MESSAGE_GOTIFY_PRIORITY || process.env.MESSAGE_GOTIFY_PRIORITY, 10);
  const url = `${server.replace(/\/$/, '')}/message`;
  await axios.post(
    url,
    {
      title,
      message: content,
      priority: Number.isNaN(priority) ? 5 : priority,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Gotify-Key': token,
      },
      timeout: 5000,
    }
  );
  return true;
}

async function send(title, content) {
  const text = `${title}\n${content}\n${new Date().toLocaleString('zh-CN')}`;

  const results = await Promise.allSettled([sendFeishu(title, content, text), sendGotify(title, content)]);

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[notify] 发送失败:', result.reason.message);
    }
  }
}

async function shouldNotify(roomUrl) {
  // 增加判断条件：如果是开发环境，默认不启用通知（除非数据库里明确开启了）
  if (process.env.NODE_ENV === 'development') {
    return false;
  }
  if (!roomUrl) return true;
  try {
    const pool = require('../../db/index');
    const r = await pool.query('SELECT notification_enabled FROM rooms WHERE room_url = $1', [roomUrl]);
    return r.rows.length === 0 || r.rows[0].notification_enabled !== false;
  } catch (_) {
    return true;
  }
}

async function recordingStart(roomName, caption, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send('🎬 开始录制', `直播间：${roomName || '未知'}${caption ? '\n标题：' + caption : ''}`);
}

async function recordingComplete(roomName, fileCount, totalMB, sessionId, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    '✅ 录制完成',
    `直播间：${roomName || '未知'}\n文件：${fileCount} 段\n大小：${totalMB} MB\n会话ID：${sessionId}`
  );
}

async function uploadStart(roomName, tmplName, fileCount, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send('📤 开始投稿', `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n文件：${fileCount} 个`);
}

async function uploadComplete(roomName, title, bvId, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send('✅ 投稿完成', `直播间：${roomName || '未知'}\n标题：${title || '未知'}\nBV号：${bvId || '无'}`);
}

async function uploadFailed(roomName, tmplName, title, error, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    '❌ 投稿失败',
    `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n标题：${title || '未知'}\n错误：${error || '未知'}`
  );
}

async function backupStart(roomName, tmplName, fileCount, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send('📤 开始NAS备份', `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n文件：${fileCount} 个`);
}

async function backupComplete(roomName, tmplName, fileCount, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send('✅ NAS备份完成', `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n文件：${fileCount} 个`);
}

async function backupFailed(roomName, tmplName, fileCount, error, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    '❌ NAS备份失败',
    `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n文件：${fileCount} 个\n错误：${error || '未知'}`
  );
}

async function filesDeleted(roomName, tmplName, deleted, failed, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    '🗑️ 本地文件已清理',
    `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n删除：${deleted} 个\n失败：${failed} 个`
  );
}

module.exports = {
  send,
  recordingStart,
  recordingComplete,
  uploadStart,
  uploadComplete,
  uploadFailed,
  backupStart,
  backupComplete,
  backupFailed,
  filesDeleted,
};
