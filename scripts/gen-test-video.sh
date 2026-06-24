#!/bin/bash
# gen-test-video.sh
# 生成 1920x1080 / 1 分钟测试视频（testsrc2 彩色测试卡 + 440Hz 测试音）
# 用途：弹幕压制、转码流程等功能测试
#
# 用法：
#   ./scripts/gen-test-video.sh [输出文件路径]
#   默认输出到 dev_downloads/test_1080p_60s.mp4
# 
#   ./scripts/gen-test-video.sh dev_downloads/2/24/20260623_232232.ts 
#     自定义输出路径

OUTPUT="${1:-dev_downloads/test_1080p_60s.mp4}"

echo "生成测试视频: $OUTPUT"
echo "分辨率: 1920x1080 | 时长: 60s | 帧率: 30fps"

ffmpeg -y \
  -f lavfi -i testsrc2=size=1920x1080:rate=30 \
  -f lavfi -i sine=frequency=440:sample_rate=44100 \
  -t 60 \
  -c:v libx264 -crf 18 -preset fast \
  -c:a aac -b:a 128k \
  "$OUTPUT"

echo "完成: $OUTPUT"
