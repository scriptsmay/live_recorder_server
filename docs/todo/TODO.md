# TODO

## 重构输出文件的默认保存路径

目前项目中设计的直播录制文件保存路径都是在 `VIDEO_DOWNLOAD_DIR` 安装文件名模板输出文件名平铺，这样容易造成文件名冲突，看门狗全局扫描时也不好区分不同会话的文件。
项目需求是：

- 将录制文件的保存路径增加层级，如：`VIDEO_DOWNLOAD_DIR/[RoomId]/[会话ID]/[文件名]`
- 更新相关输出文件名的工具函数；
- 看门狗扫描逻辑同步更新，只需要通过不同状态过滤需要扫描的会话目录下的文件情况；
- 投稿时也只需要查询对应目录下的文件；

## 优化 ffmpeg 下载命令行参数

参考命令：

```bash
ffmpeg -y \
    -v verbose \
    -rw_timeout 30000000 \
    -loglevel error \
    -hide_banner \
    -user_agent "Mozilla/5.0 ..." \
    -protocol_whitelist "rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy" \
    -thread_queue_size 1024 \
    -analyzeduration 20000000 \
    -probesize 20000000 \
    -fflags +discardcorrupt \
    -re \
    -i "直播流URL" \
    -bufsize 15000k \
    -sn -dn \
    -reconnect_delay_max 60 \
    -reconnect_streamed \
    -reconnect_at_eof \
    -max_muxing_queue_size 2048 \
    -correct_ts_overflow 1 \
    -avoid_negative_ts 1 \
    [输出参数] \
    [保存路径]
```
