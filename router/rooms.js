const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const redis = require('../db/redis');
const RoomService = require('../services/RoomService');
const DataService = require('../services/DataService');

router.get('/rooms', async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const { rows, total } = await DataService.getRooms({
      status,
      page,
      limit,
    });
    res.json({ status: 'ok', data: rows, total });
  } catch (err) {
    console.error('[rooms] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

router.post('/rooms', async (req, res) => {
  try {
    const {
      room_url,
      room_name,
      notification_enabled,
      monitoring_enabled,
      segment_duration,
      filename_template,
      upload_template_id,
    } = req.body;
    if (!room_url) {
      return res.status(400).json({ status: 'Error', message: '缺少 room_url' });
    }

    const exist = await pool.query('SELECT * FROM rooms WHERE room_url = $1', [room_url]);
    if (exist.rows.length > 0) {
      const fields = [];
      const values = [];
      const fieldsList = [
        'room_name',
        'notification_enabled',
        'monitoring_enabled',
        'segment_duration',
        'filename_template',
        'upload_template_id',
      ];
      const reqBody = {
        room_name,
        notification_enabled,
        monitoring_enabled,
        segment_duration,
        filename_template,
        upload_template_id,
      };
      for (const f of fieldsList) {
        if (reqBody[f] !== undefined) {
          fields.push(`${f} = $${values.length + 1}`);
          values.push(reqBody[f]);
        }
      }
      if (fields.length > 0) {
        values.push(room_url);
        await pool.query(
          `UPDATE rooms SET ${fields.join(', ')}, updated_at = NOW() WHERE room_url = $${values.length}`,
          values
        );
      }
      return res.json({ status: 'ok', data: exist.rows[0], updated: true });
    }

    const result = await pool.query(
      `INSERT INTO rooms (room_url, room_name, notification_enabled, monitoring_enabled, segment_duration, filename_template, upload_template_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        room_url,
        room_name || '',
        notification_enabled !== false,
        monitoring_enabled !== false,
        segment_duration || 0,
        filename_template || '',
        upload_template_id || null,
      ]
    );
    res.json({ status: 'ok', data: result.rows[0], updated: false });
  } catch (err) {
    console.error('[rooms] 创建失败:', err);
    res.status(500).json({ status: 'Error', message: '创建失败' });
  }
});

router.get('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const room = await DataService.getRoomById(id);
    if (!room) {
      return res.status(404).json({ status: 'Error', message: '直播间不存在' });
    }
    res.json({ status: 'ok', data: room });
  } catch (err) {
    console.error('[rooms] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

const ROOM_FIELDS_IDLE = [
  'room_name',
  'notification_enabled',
  'monitoring_enabled',
  'segment_duration',
  'filename_template',
  'upload_template_id',
];
const ROOM_FIELDS_WHILE_RECORDING = ['notification_enabled', 'upload_template_id'];

router.put('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await pool.query('SELECT status FROM rooms WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '直播间不存在' });
    }
    const isActive = ['recording', 'paused'].includes(existing.rows[0].status);
    const fields = isActive ? ROOM_FIELDS_WHILE_RECORDING : ROOM_FIELDS_IDLE;

    const sets = [];
    const values = [];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = $${values.length + 1}`);
        values.push(req.body[field]);
      }
    }
    if (sets.length === 0) {
      const msg = isActive ? '录制中仅可更新通知开关与投稿模板' : '无更新字段';
      return res.status(400).json({ status: 'Error', message: msg });
    }
    const blocked = Object.keys(req.body).filter(
      (k) => req.body[k] !== undefined && !fields.includes(k)
    );
    if (blocked.length > 0) {
      return res.status(400).json({
        status: 'Error',
        message: '录制中仅可更新通知开关与投稿模板',
      });
    }
    values.push(id);
    const result = await pool.query(
      `UPDATE rooms SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '直播间不存在' });
    }
    await redis.del(`room:${result.rows[0].room_url}`).catch(() => {});
    res.json({ status: 'ok', data: result.rows[0] });
  } catch (err) {
    console.error('[rooms] 更新失败:', err);
    res.status(500).json({ status: 'Error', message: '更新失败' });
  }
});

router.delete('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await RoomService.deleteRoom(id);
    if (!result.success) {
      return res.status(404).json({ status: 'Error', message: result.message });
    }
    res.json({ status: 'ok', message: result.message });
  } catch (err) {
    console.error('[rooms] 删除失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

router.post('/rooms/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
    if (room.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '直播间不存在' });
    }
    const result = await RoomService.pauseRecording(room.rows[0].room_url);
    if (!result.success) {
      return res.status(400).json({ status: 'Error', message: result.message });
    }
    res.json({ status: 'ok', message: result.message });
  } catch (err) {
    console.error('[rooms] 暂停失败:', err);
    res.status(500).json({ status: 'Error', message: '暂停失败' });
  }
});

router.post('/rooms/:id/resume', async (req, res) => {
  try {
    const { id } = req.params;
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
    if (room.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '直播间不存在' });
    }
    const result = await RoomService.resumeRecording(room.rows[0].room_url);
    if (!result.success) {
      return res.status(400).json({ status: 'Error', message: result.message });
    }
    res.json({ status: 'ok', message: result.message });
  } catch (err) {
    console.error('[rooms] 恢复失败:', err);
    res.status(500).json({ status: 'Error', message: '恢复失败' });
  }
});

router.post('/rooms/:id/stop', async (req, res) => {
  try {
    const { id } = req.params;
    const { force } = req.body;
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
    if (room.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '直播间不存在' });
    }
    const result = await RoomService.stopRecording(room.rows[0].room_url, force === true);
    res.json({ status: 'ok', message: result.message });
  } catch (err) {
    console.error('[rooms] 停止失败:', err);
    res.status(500).json({ status: 'Error', message: '停止失败' });
  }
});

router.get('/sessions', async (req, res) => {
  try {
    const { room_url, status, page = 1, limit = 20 } = req.query;
    const data = await DataService.getSessions({
      room_url,
      status,
      page,
      limit,
    });
    res.json({ status: 'ok', data });
  } catch (err) {
    console.error('[sessions] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

router.get('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM recording_sessions WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '会话不存在' });
    }
    const recordings = await pool.query('SELECT * FROM recordings WHERE session_id = $1 ORDER BY id', [id]);
    // 检查文件是否存在
    const recordingsWithExists = recordings.rows.map((rec) => ({
      ...rec,
      file_exists: rec.file_path ? require('fs').existsSync(rec.file_path) : false,
    }));
    res.json({ status: 'ok', data: { ...result.rows[0], recordings: recordingsWithExists } });
  } catch (err) {
    console.error('[sessions] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

router.delete('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const session = await pool.query('SELECT * FROM recording_sessions WHERE id = $1', [id]);
    if (session.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '会话不存在' });
    }
    await pool.query('UPDATE recording_sessions SET deleted_at = NOW() WHERE id = $1', [id]);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[sessions] 删除失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

module.exports = router;
