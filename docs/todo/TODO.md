# TODO

## ~~分段录制完成后没有执行自动投稿~~（已修复）

看门狗周期内调用 `UploadService.scanPendingAutoUpload()`：会话 `completed`、文件转码就绪、直播间已绑定投稿模板、且无 `uploading`/`success` 投稿记录时自动投稿。
