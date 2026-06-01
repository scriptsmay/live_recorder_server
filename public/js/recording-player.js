/**
 * 录制视频播放器模块
 * 提供统一的录制视频播放功能，支持 HLS 和直接播放
 */

const RecordingPlayer = {
  /**
   * 播放录制视频
   * @param {number} recordingId - 录制文件 ID
   * @param {string} filename - 文件名（用于显示标题）
   * @param {string} ext - 文件扩展名
   * @param {function} [toastFn] - 可选的 toast 函数
   * @returns {Promise<void>}
   */
  async play(recordingId, filename, ext, toastFn = toast) {
    const title = filename || '视频预览';

    try {
      const hlsRes = await fetch(`/api/recordings/${recordingId}/hls`);
      const hlsJson = await hlsRes.json();

      if (hlsJson.data && hlsJson.data.is_ready) {
        const hlsSrc = '/hls/' + hlsJson.data.relative_path;
        openVideoPlayer(hlsSrc, title, 'm3u8');
      } else {
        const src = `/api/recordings/${recordingId}/stream`;
        const res = await fetch(src, { headers: { Range: 'bytes=0-1' } });
        if (res.ok || res.status === 206) {
          openVideoPlayer(src, title, ext);
        } else {
          let errorMsg = '视频加载失败，状态码：' + res.status;
          if (res.headers.get('content-type')?.includes('application/json')) {
            const json = await res.json();
            errorMsg = json.message || errorMsg;
          }
          if (toastFn) toastFn(errorMsg);
        }
      }
    } catch (err) {
      if (toastFn) toastFn('视频加载失败：' + (err.message || '未知错误'));
    }
  },

  /**
   * 初始化播放按钮事件监听
   * 自动为所有带有 .playRecBtn 类的按钮绑定播放事件
   * @param {function} [toastFn] - 可选的 toast 函数
   */
  init(toastFn = toast) {
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.playRecBtn');
      if (!btn) return;

      e.preventDefault();
      const recordingId = btn.dataset.recordingId;
      const filename = btn.dataset.filename || '视频预览';
      const ext = btn.dataset.ext || 'mp4';

      await this.play(recordingId, filename, ext, toastFn);
    });
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RecordingPlayer;
}
