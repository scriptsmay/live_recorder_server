#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HuyaChecker = require('../lib/core/polling/HuyaChecker');

const TEST_OUTPUT_DIR = path.join(__dirname, '..', 'test_downloads');

if (!fs.existsSync(TEST_OUTPUT_DIR)) {
  fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
}

async function main() {
  const args = process.argv.slice(2);
  let testRoomUrl = 'https://www.huya.com/362522';
  let testDuration = 30;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      testRoomUrl = args[i + 1];
      i++;
    } else if (args[i] === '--duration' && args[i + 1]) {
      testDuration = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--help') {
      console.log('用法: node test_huya_ffmpeg_download.js [--url <直播间URL>] [--duration <秒数>]');
      console.log('示例:');
      console.log('  node test_huya_ffmpeg_download.js');
      console.log('  node test_huya_ffmpeg_download.js --url https://www.huya.com/362522');
      console.log('  node test_huya_ffmpeg_download.js --url https://www.huya.com/362522 --duration 60');
      process.exit(0);
    }
  }

  console.log('=== 虎牙直播流下载测试 ===');
  console.log(`测试直播间: ${testRoomUrl}`);
  console.log(`测试时长: ${testDuration}秒`);
  console.log();

  console.log('[1/3] 测试虎牙直播间状态检查...');
  const checker = new HuyaChecker(testRoomUrl);
  const status = await checker.checkStatus();

  console.log('状态检查结果:', JSON.stringify(status, null, 2));
  console.log();

  if (!status.isLive) {
    console.log('⚠️  直播间当前未开播，无法测试下载');
    process.exit(0);
  }

  if (!status.streamUrl) {
    console.log('❌ 无法获取直播流地址');
    process.exit(1);
  }

  console.log('[2/3] 获取到的直播流地址:');
  console.log(status.streamUrl);
  console.log();

  console.log(`[3/3] 测试 ffmpeg 下载（${testDuration}秒）...`);
  const outputPath = path.join(TEST_OUTPUT_DIR, `test_${Date.now()}.flv`);

  const ffmpegArgs = [
    '-i',
    status.streamUrl,
    '-t',
    String(testDuration),
    '-c',
    'copy',
    '-fflags',
    '+genpts',
    '-timeout',
    '2147483647',
    '-reconnect',
    '1',
    '-reconnect_at_eof',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '60',
    '-rw_timeout',
    '30000000',
    '-analyzeduration',
    '10000000',
    '-probesize',
    '5000000',
    outputPath,
  ];

  console.log('ffmpeg 命令:', 'ffmpeg ' + ffmpegArgs.join(' '));
  console.log();

  let startTime = Date.now();
  let lastProgressTime = 0;

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  ffmpeg.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.includes('time=')) {
        const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (timeMatch) {
          const currentTime = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
          if (currentTime !== lastProgressTime) {
            lastProgressTime = currentTime;
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            console.log(`\r[${elapsed}s] 录制进度: ${timeMatch[0]}`, ' '.repeat(20));
          }
        }
      }
      if (line.includes('size=')) {
        const sizeMatch = line.match(/size=\s*(\d+)(kB|MB|GB)?/);
        if (sizeMatch) {
          let sizeMB = parseInt(sizeMatch[1]);
          if (sizeMatch[2] === 'kB') sizeMB = sizeMB / 1024;
          if (sizeMatch[2] === 'GB') sizeMB = sizeMB * 1024;
          process.stdout.write(` | 大小: ${sizeMB.toFixed(2)} MB`);
        }
      }
    }
  });

  ffmpeg.on('error', (err) => {
    console.error('\n❌ ffmpeg 启动失败:', err.message);
    process.exit(1);
  });

  ffmpeg.on('close', (code) => {
    console.log('\n');
    if (code === 0) {
      console.log('✅ 下载测试成功！');
      console.log(`输出文件: ${outputPath}`);
      if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath);
        console.log(`文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        console.log(`录制时长: ${(stats.size / 1024 / 1024 / (stats.size / 1024 / 1024 / testDuration)).toFixed(2)}秒`);
      }
    } else {
      console.log(`❌ ffmpeg 退出，代码: ${code}`);
    }
    process.exit(code);
  });

  setTimeout(
    () => {
      console.log('\n⏱️  到达预设时间，停止录制...');
      ffmpeg.kill('SIGTERM');
    },
    testDuration * 1000 + 1000
  );
}

main().catch((err) => {
  console.error('❌ 测试脚本执行失败:', err);
  process.exit(1);
});
