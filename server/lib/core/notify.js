const axios = require('axios');
const config = require('../../config/config');

/**
 * 从数据库读取通知设置（单次查询，三渠道共用）
 */
async function getNotifySettings() {
  try {
    const pool = require('../../db/index');
    const keys = [
      'feishu_webhook_enabled',
      'feishu_webhook_url',
      'gotify_enabled',
      'gotify_server',
      'gotify_token',
      'gotify_priority',
      'webhook_enabled',
      'webhook_url',
    ];
    const { rows } = await pool.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [keys]);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch (_) {
    return {};
  }
}

async function sendFeishu(title, content, text, settings) {
  const s = settings || {};
  const dbEnabled = s.feishu_webhook_enabled === 'true';
  const dbUrl = (s.feishu_webhook_url || '').trim();
  const envUrl = config.MESSAGE_FEISHU_WEBHOOK || process.env.MESSAGE_FEISHU_WEBHOOK || '';
  // DB 启用时用 DB URL；否则回退到环境变量（向后兼容）
  const webhookUrl = dbEnabled ? dbUrl || envUrl : envUrl;
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

async function sendGotify(title, content, settings) {
  const s = settings || {};
  const dbEnabled = s.gotify_enabled === 'true';
  const dbServer = (s.gotify_server || '').trim();
  const dbToken = (s.gotify_token || '').trim();
  const envServer = config.MESSAGE_GOTIFY_SERVER || process.env.MESSAGE_GOTIFY_SERVER || '';
  const envToken = config.MESSAGE_GOTIFY_TOKEN || process.env.MESSAGE_GOTIFY_TOKEN || '';
  // DB 启用时用 DB 值；否则回退到环境变量（向后兼容）
  const server = dbEnabled ? dbServer || envServer : envServer;
  const token = dbEnabled ? dbToken || envToken : envToken;
  if (!server || !token) return false;

  const priorityRaw = dbEnabled
    ? s.gotify_priority || config.MESSAGE_GOTIFY_PRIORITY || process.env.MESSAGE_GOTIFY_PRIORITY
    : config.MESSAGE_GOTIFY_PRIORITY || process.env.MESSAGE_GOTIFY_PRIORITY;
  const priority = parseInt(priorityRaw, 10);
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

async function sendWebhook(eventType, title, content, settings) {
  const s = settings || {};
  if (s.webhook_enabled !== 'true') return false;
  const url = (s.webhook_url || '').trim();
  if (!url) return false;

  await axios.post(
    url,
    {
      event: eventType,
      title,
      content,
      timestamp: new Date().toISOString(),
      source: 'k-recorder',
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
  );
  return true;
}

async function send(eventType, title, content) {
  const text = `${title}\n${content}\n${new Date().toLocaleString('zh-CN')}`;
  const settings = await getNotifySettings();

  const results = await Promise.allSettled([
    sendFeishu(title, content, text, settings),
    sendGotify(title, content, settings),
    sendWebhook(eventType, title, content, settings),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[notify] 发送失败:', result.reason.message);
    }
  }
}

async function shouldNotify(roomUrl) {
  // 开发和测试环境下不发送通知
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
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
  send('recording_start', '🎬 开始录制', `直播间：${roomName || '未知'}${caption ? '\n标题：' + caption : ''}`);
}

async function recordingComplete(roomName, fileCount, totalMB, sessionId, roomUrl, status = 'completed') {
  if (!(await shouldNotify(roomUrl))) return;
  if (status === 'interrupted') {
    send(
      'recording_interrupted',
      '⚠️ 录制中断',
      `直播间：${roomName || '未知'}\n文件：${fileCount} 段\n大小：${totalMB} MB\n会话ID：${sessionId}\n\n录制异常中断，文件可能不完整`
    );
  } else {
    send(
      'recording_complete',
      '✅ 录制完成',
      `直播间：${roomName || '未知'}\n文件：${fileCount} 段\n大小：${totalMB} MB\n会话ID：${sessionId}`
    );
  }
}

async function uploadStart(roomName, tmplName, fileCount, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    'upload_start',
    '📤 开始投稿',
    `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n文件：${fileCount} 个`
  );
}

async function uploadComplete(roomName, title, bvId, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    'upload_complete',
    '✅ 投稿完成',
    `直播间：${roomName || '未知'}\n标题：${title || '未知'}\nBV号：${bvId || '无'}`
  );
}

async function uploadFailed(roomName, tmplName, title, error, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    'upload_failed',
    '❌ 投稿失败',
    `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n标题：${title || '未知'}\n错误：${error || '未知'}`
  );
}

async function backupStart(roomName, tmplName, fileCount, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    'backup_start',
    '📤 开始NAS备份',
    `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n文件：${fileCount} 个`
  );
}

async function backupComplete(roomName, tmplName, fileCount, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    'backup_complete',
    '✅ NAS备份完成',
    `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n文件：${fileCount} 个`
  );
}

async function backupFailed(roomName, tmplName, fileCount, error, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    'backup_failed',
    '❌ NAS备份失败',
    `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n文件：${fileCount} 个\n错误：${error || '未知'}`
  );
}

async function filesDeleted(roomName, tmplName, deleted, failed, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send(
    'files_deleted',
    '🗑️ 本地文件已清理',
    `直播间：${roomName || '未知'}\n模板：${tmplName || '未知'}\n删除：${deleted} 个\n失败：${failed} 个`
  );
}

async function liveStart(roomName, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send('live_start', '🟢 直播开始', `直播间：${roomName || '未知'}${roomUrl ? '\n链接：' + roomUrl : ''}`);
}

async function liveEnd(roomName, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  send('live_end', '⚫ 直播结束', `直播间：${roomName || '未知'}${roomUrl ? '\n链接：' + roomUrl : ''}`);
}

async function replayPipelineComplete(roomName, stepName, recordId, detail = {}, roomUrl) {
  if (!(await shouldNotify(roomUrl))) return;
  const lines = [`主播：${roomName || '未知'}`, `记录ID：${recordId}`, `步骤：${stepName || '未知'}`];

  if (detail.status) lines.push(`状态：${detail.status}`);
  if (detail.m3u8_url) lines.push(`m3u8：${detail.m3u8_url}`);
  if (detail.raw_file_path) lines.push(`原始文件：${detail.raw_file_path}`);
  if (detail.file_size) lines.push(`文件大小：${detail.file_size}`);
  if (Array.isArray(detail.cut_file_paths)) lines.push(`切片文件：${detail.cut_file_paths.length} 个`);
  if (Array.isArray(detail.final_file_paths)) lines.push(`最终文件：${detail.final_file_paths.length} 个`);
  if (detail.upload_record_id) lines.push(`投稿记录ID：${detail.upload_record_id}`);

  send('replay_pipeline_complete', '✅ 直播回放处理完成', lines.join('\n'));
}

async function replayCliComplete(principalName, total, success, failed) {
  if (!(await shouldNotify())) return;
  if (failed > 0) {
    send(
      'replay_cli_complete',
      '⚠️ 回放批量处理完成',
      [
        `主播：${principalName || '未知'}`,
        `共 ${total} 条回放：${success} 条成功，${failed} 条失败`,
        '',
        '请到「回放工具箱」页面查看失败详情',
      ].join('\n')
    );
  } else {
    send(
      'replay_cli_complete',
      '✅ 回放批量处理完成',
      [`主播：${principalName || '未知'}`, `共 ${total} 条回放全部处理成功`].join('\n')
    );
  }
}

async function replayCliActionComplete(roomName, action, recordId, success, error) {
  if (!(await shouldNotify())) return;
  const actionNames = {
    extract: '提取回放地址',
    download: '下载回放视频',
    cut: '切片',
    fix: '修复分辨率',
    upload: '投稿',
  };
  const actionName = actionNames[action] || action;

  if (success) {
    send(
      'replay_cli_action_complete',
      '✅ 回放处理完成',
      `主播：${roomName || '未知'}\n操作：${actionName}\n记录ID：${recordId}`
    );
  } else {
    send(
      'replay_cli_action_failed',
      '❌ 回放处理失败',
      `主播：${roomName || '未知'}\n操作：${actionName}\n记录ID：${recordId}\n错误：${error || '未知'}`
    );
  }
}

/**
 * 测试通知：发送一条测试消息到所有已启用的渠道
 */
async function testNotify() {
  const eventType = 'test';
  const title = '🔔 测试通知';
  const content = '这是一条来自 K-Recorder 的测试通知';
  const text = `${title}\n${content}\n${new Date().toLocaleString('zh-CN')}`;
  const settings = await getNotifySettings();

  const results = await Promise.allSettled([
    sendFeishu(title, content, text, settings),
    sendGotify(title, content, settings),
    sendWebhook(eventType, title, content, settings),
  ]);

  const channelResults = [
    { channel: 'feishu', enabled: !!(settings.feishu_webhook_url || config.MESSAGE_FEISHU_WEBHOOK) },
    { channel: 'gotify', enabled: !!(settings.gotify_server || config.MESSAGE_GOTIFY_SERVER) },
    { channel: 'webhook', enabled: settings.webhook_enabled === 'true' },
  ];

  results.forEach((r, i) => {
    channelResults[i].sent = r.status === 'fulfilled' && r.value === true;
    if (r.status === 'rejected') {
      channelResults[i].error = r.reason.message;
    }
  });

  return channelResults;
}

module.exports = {
  send,
  testNotify,
  recordingStart,
  recordingComplete,
  uploadStart,
  uploadComplete,
  uploadFailed,
  backupStart,
  backupComplete,
  backupFailed,
  filesDeleted,
  liveStart,
  liveEnd,
  replayPipelineComplete,
  replayCliComplete,
  replayCliActionComplete,
};
