const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const redis = require('../db/redis');

async function delRoomCache(roomUrl) {
  try {
    if (roomUrl) await redis.del(`room:${roomUrl}`);
  } catch (_) {}
}

async function renderRoomsHtml(res) {
  const result = await pool.query('SELECT * FROM rooms ORDER BY id DESC');
  res.render('partials/_rooms_table', { rooms: result.rows, layout: false });
}

// GET /api/rooms — 直播间列表
router.get('/rooms', async (req, res) => {
  try {
    const { status } = req.query;
    let query = 'SELECT * FROM rooms ORDER BY id DESC';
    const params = [];
    if (status) {
      query = 'SELECT * FROM rooms WHERE status = $1 ORDER BY id DESC';
      params.push(status);
    }
    const result = await pool.query(query, params);
    res.json({ status: 'ok', data: result.rows });
  } catch (err) {
    console.error('[rooms] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '数据库查询失败' });
  }
});

// POST /api/rooms — 新增直播间
router.post('/rooms', async (req, res) => {
  try {
    const { room_url, room_name, filename_template, segment_duration } = req.body;
    if (!room_url) {
      return res.status(400).json({ status: 'Error', message: 'room_url 必填' });
    }
    const result = await pool.query(
      `INSERT INTO rooms (room_url, room_name, filename_template, segment_duration)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_url) DO UPDATE SET
         room_name = COALESCE($2, rooms.room_name),
         filename_template = COALESCE($3, rooms.filename_template),
         segment_duration = COALESCE($4, rooms.segment_duration),
         updated_at = NOW()
       RETURNING *`,
      [room_url, room_name || '', filename_template || null, segment_duration ?? null]
    );
    await delRoomCache(result.rows[0].room_url);
    if (req.headers['hx-request']) return renderRoomsHtml(res);
    res.status(201).json({ status: 'ok', data: result.rows[0] });
  } catch (err) {
    console.error('[rooms] 创建失败:', err);
    if (req.headers['hx-request']) return res.status(500).send('创建失败');
    res.status(500).json({ status: 'Error', message: '创建失败' });
  }
});

// GET /api/rooms/:id — 直播间详情
router.get('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '直播间不存在' });
    }
    res.json({ status: 'ok', data: result.rows[0] });
  } catch (err) {
    console.error('[rooms] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

// PUT /api/rooms/:id — 更新直播间
router.put('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { room_name, filename_template, segment_duration } = req.body;
    const result = await pool.query(
      `UPDATE rooms
       SET room_name = COALESCE($1, room_name),
           filename_template = COALESCE($2, filename_template),
           segment_duration = COALESCE($3, segment_duration, 0),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [room_name, filename_template, segment_duration != null ? segment_duration : null, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '直播间不存在' });
    }
    await delRoomCache(result.rows[0].room_url);
    if (req.headers['hx-request']) return renderRoomsHtml(res);
    res.json({ status: 'ok', data: result.rows[0] });
  } catch (err) {
    console.error('[rooms] 更新失败:', err);
    if (req.headers['hx-request']) return res.status(500).send('更新失败');
    res.status(500).json({ status: 'Error', message: '更新失败' });
  }
});

// DELETE /api/rooms/:id — 删除直播间
router.delete('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
    if (room.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '直播间不存在' });
    }
    if (room.rows[0].status !== 'idle') {
      return res.status(400).json({ status: 'Error', message: '直播间录制中，无法删除' });
    }
    await delRoomCache(room.rows[0].room_url);
    await pool.query('DELETE FROM rooms WHERE id = $1', [id]);
    if (req.headers['hx-request']) return renderRoomsHtml(res);
    res.json({ status: 'ok', message: '已删除' });
  } catch (err) {
    console.error('[rooms] 删除失败:', err);
    if (req.headers['hx-request']) return res.status(500).send('删除失败');
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

// POST /api/rooms/:id/pause — 暂停录制
router.post('/rooms/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
    if (room.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '直播间不存在' });
    }
    const r = room.rows[0];
    if (r.status !== 'recording') {
      return res.status(400).json({ status: 'Error', message: '当前状态不可暂停' });
    }
    if (r.ffmpeg_pid) {
      try {
        process.kill(r.ffmpeg_pid, 'SIGSTOP');
      } catch (killErr) {
        console.error('[rooms] SIGSTOP 失败:', killErr.message);
      }
    }
    await pool.query(
      `UPDATE rooms SET status = 'paused', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    await delRoomCache(r.room_url);
    if (req.headers['hx-request']) return renderRoomsHtml(res);
    res.json({ status: 'ok', message: '已暂停录制' });
  } catch (err) {
    console.error('[rooms] 暂停失败:', err);
    if (req.headers['hx-request']) return res.status(500).send('暂停失败');
    res.status(500).json({ status: 'Error', message: '暂停失败' });
  }
});

// POST /api/rooms/:id/resume — 恢复录制
router.post('/rooms/:id/resume', async (req, res) => {
  try {
    const { id } = req.params;
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
    if (room.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '直播间不存在' });
    }
    const r = room.rows[0];
    if (r.status !== 'paused') {
      return res.status(400).json({ status: 'Error', message: '当前状态不可恢复' });
    }
    if (r.ffmpeg_pid) {
      try {
        process.kill(r.ffmpeg_pid, 'SIGCONT');
      } catch (killErr) {
        console.error('[rooms] SIGCONT 失败:', killErr.message);
      }
    }
    await pool.query(
      `UPDATE rooms SET status = 'recording', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    await delRoomCache(r.room_url);
    if (req.headers['hx-request']) return renderRoomsHtml(res);
    res.json({ status: 'ok', message: '已恢复录制' });
  } catch (err) {
    console.error('[rooms] 恢复失败:', err);
    if (req.headers['hx-request']) return res.status(500).send('恢复失败');
    res.status(500).json({ status: 'Error', message: '恢复失败' });
  }
});

// POST /api/rooms/:id/stop — 停止录制
router.post('/rooms/:id/stop', async (req, res) => {
  try {
    const { id } = req.params;
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
    if (room.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '直播间不存在' });
    }
    const r = room.rows[0];
    if (r.status === 'idle') {
      return res.status(400).json({ status: 'Error', message: '当前未在录制' });
    }
    if (r.ffmpeg_pid) {
      try {
        process.kill(r.ffmpeg_pid, 'SIGTERM');
      } catch (killErr) {
        console.error('[rooms] SIGTERM 失败:', killErr.message);
      }
    }
    await pool.query(
      `UPDATE rooms SET status = 'idle', ffmpeg_pid = NULL, updated_at = NOW() WHERE id = $1`,
      [id]
    );
    await pool.query(
      `UPDATE recordings SET ended_at = NOW(), status = 'interrupted'
       WHERE room_url = $1 AND status = 'recording'`,
      [r.room_url]
    );
    await delRoomCache(r.room_url);
    if (req.headers['hx-request']) return renderRoomsHtml(res);
    res.json({ status: 'ok', message: '已停止录制' });
  } catch (err) {
    console.error('[rooms] 停止失败:', err);
    if (req.headers['hx-request']) return res.status(500).send('停止失败');
    res.status(500).json({ status: 'Error', message: '停止失败' });
  }
});

// GET /api/recordings — 录制历史列表
router.get('/recordings', async (req, res) => {
  try {
    const { room_url, limit } = req.query;
    let query = `
      SELECT r.*, rm.room_name
      FROM recordings r
      LEFT JOIN rooms rm ON r.room_url = rm.room_url
    `;
    const params = [];
    const conditions = [];
    if (room_url) {
      conditions.push(`r.room_url = $${params.length + 1}`);
      params.push(room_url);
    }
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY r.id DESC';
    if (limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(parseInt(limit, 10));
    }
    const result = await pool.query(query, params);
    res.json({ status: 'ok', data: result.rows });
  } catch (err) {
    console.error('[recordings] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

// DELETE /api/recordings/:id — 删除录制记录
router.delete('/recordings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM recordings WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '录制记录不存在' });
    }
    res.json({ status: 'ok', message: '已删除' });
  } catch (err) {
    console.error('[recordings] 删除失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

// GET /api/sessions — 录制会话列表
router.get('/sessions', async (req, res) => {
  try {
    const { room_url, limit, show_deleted } = req.query;
    const conditions = ['s.deleted_at IS NULL'];
    const params = [];
    if (room_url) {
      conditions.push(`s.room_url = $${params.length + 1}`);
      params.push(room_url);
    }
    if (show_deleted === '1') {
      conditions[0] = '1=1';
    }
    let query = `
      SELECT s.*, rm.room_name
      FROM recording_sessions s
      LEFT JOIN rooms rm ON s.room_url = rm.room_url
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.id DESC
    `;
    if (limit) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(parseInt(limit, 10));
    }
    const result = await pool.query(query, params);
    res.json({ status: 'ok', data: result.rows });
  } catch (err) {
    console.error('[sessions] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

// POST /api/sessions/:id/delete — 软删除会话
router.post('/sessions/:id/delete', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE recording_sessions SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ status: 'Error', message: '会话不存在或已删除' });
    res.json({ status: 'ok', message: '已标记删除' });
  } catch (err) {
    console.error('[sessions] 删除失败:', err);
    res.status(500).json({ status: 'Error', message: '删除失败' });
  }
});

// GET /api/sessions/:id — 会话详情（包含所有分片文件）
router.get('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const session = await pool.query(
      `SELECT s.*, rm.room_name
       FROM recording_sessions s
       LEFT JOIN rooms rm ON s.room_url = rm.room_url
       WHERE s.id = $1`,
      [id]
    );
    if (session.rows.length === 0) {
      return res.status(404).json({ status: 'Error', message: '会话不存在' });
    }
    const recordings = await pool.query(
      `SELECT * FROM recordings WHERE session_id = $1 ORDER BY segment_index ASC`,
      [id]
    );
    res.json({ status: 'ok', data: { session: session.rows[0], recordings: recordings.rows } });
  } catch (err) {
    console.error('[sessions] 查询失败:', err);
    res.status(500).json({ status: 'Error', message: '查询失败' });
  }
});

module.exports = router;
