首先，搭建一个本地的RTMP推流服务器（例如使用nginx-rtmp-module），地址是：

rtmp://127.0.0.1:1935/live

准备一个本地视频文件，执行推流命令（根据实际环境调整ffmpeg路径和视频文件路径）：

```sh
ffmpeg -re -stream_loop -1 -i "/path/to/your/test/video.mov" \
    -c:v libx264 -preset veryfast -b:v 2000k -maxrate 2000k -bufsize 4000k \
    -c:a aac -b:a 128k -f flv rtmp://127.0.0.1:1935/live/mystream
```

然后，调用api启动下载器：

```sh
STREAM_URL="rtmp://127.0.0.1:1935/live/mystream"
SERVER_API="http://127.0.0.1:3001/api/notify/live_download"

curl -X POST "$SERVER_API" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"$STREAM_URL\", \"title\": \"测试直播间\", \"caption\": \"测试直播标题\", \"room_url\": \"https://live.example.com/room1\"}"
```

接下来就可以观察不同情况下系统数据的表现了：

情况1 ：5分钟后主动停止推流，查看ffmpeg进程是否会停止录制，会话是否状态变成已完成。录制文件是否存在于下载目录，大小超过文件阈值。看门狗下次执行周期时是否会扫描文件执行自动转码流程？

情况2： 5分钟主动调用项目中的api接口，停止这个直播间的录制。观察数据变化情况。
