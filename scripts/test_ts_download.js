#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const HuyaChecker = require('../lib/core/polling/HuyaChecker');
const TsDownloader = require('../lib/core/downloaders/TsDownloader');

const TEST_OUTPUT_DIR = path.join(__dirname, '..', 'dev_downloads');

if (!fs.existsSync(TEST_OUTPUT_DIR)) {
  fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
}

async function main() {
  const args = process.argv.slice(2);
  let testRoomUrl = 'https://www.huya.com/kpl';
  let testDuration = 10;
  let testQuality = 'UHD';
  let useDirectStreamUrl = true; // 默认使用房间 URL（完全按照参考项目）
  let maxRetries = 30; // Python 下载器自动重连次数
  let segmentDuration = 0; // 分段时长（测试切割功能）

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      testRoomUrl = args[i + 1];
      i++;
    } else if (args[i] === '--duration' && args[i + 1]) {
      testDuration = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--quality' && args[i + 1]) {
      testQuality = args[i + 1];
      i++;
    } else if (args[i] === '--max-retries' && args[i + 1]) {
      maxRetries = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--direct-stream') {
      useDirectStreamUrl = true;
    } else if (args[i] === '--no-direct-stream') {
      useDirectStreamUrl = false;
    } else if (args[i] === '--help') {
      console.log('用法: node test_ts_download.js [选项]');
      console.log();
      console.log('选项:');
      console.log('  --url &lt;直播间URL&gt;        指定测试的虎牙直播间 URL');
      console.log('  --duration &lt;秒数&gt;         测试录制时长（默认：30秒）');
      console.log('  --quality &lt;画质&gt;          指定画质（OD/BD/UHD/HD/SD/LD，默认：UHD）');
      console.log('  --max-retries &lt;次数&gt;      Python下载器自动重连次数（默认：30）');
      console.log('  --help                    显示帮助信息');
      console.log();
      console.log('示例:');
      console.log('  node test_ts_download.js');
      console.log('  node test_ts_download.js --url https://www.huya.com/kpl');
      console.log('  node test_ts_download.js --url https://www.huya.com/kpl --duration 60 --quality HD');
      process.exit(0);
    }
  }

  console.log('=== 虎牙 ts 下载器测试 ===');
  console.log(`测试直播间: ${testRoomUrl}`);
  console.log(`测试时长: ${testDuration}秒`);
  console.log(`自动重连次数: ${maxRetries}`);
  console.log(`测试画质: ${testQuality}`);
  console.log(`直接使用流 URL: ${useDirectStreamUrl ? '是' : '否'}`);
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

  console.log('[2/3] 准备使用 TsDownloader 测试...');
  const downloader = new TsDownloader();

  const fileExt = downloader.getExtension();

  console.log('下载器名称:', downloader.name);
  console.log('文件扩展名:', fileExt);
  console.log('默认选项:', downloader.getDefaultOptions());
  console.log();

  const outputPath = path.join(TEST_OUTPUT_DIR, `test_${status.roomName}_${Date.now()}${fileExt}`);

  console.log('使用直接流 URL 模式');
  console.log(`[3/3] 开始测试录制（${testDuration}秒）...`);
  console.log(`URL: ${status.streamUrl}`);

  // --- 新增：手动构建并打印参数 ---
  const options = { segmentDuration };
  const finalArgs = downloader.buildArgs(status.streamUrl, outputPath, options);

  // 打印拼接好的完整命令行字符串，方便直接复制到终端运行测试
  console.log('--------------------------------------------------');
  console.log('FFmpeg 执行命令:');
  console.log(`ffmpeg ${finalArgs.join(' ')}`);
  console.log('--------------------------------------------------');
  // ------------------------------

  // 1. 订阅事件
  downloader.on('progress', (p) => {
    console.log(`进度更新: ${p.timeSeconds}s`);
  });

  downloader.on('exit', (code) => {
    console.log(`进程结束，退出码: ${code}`);
  });

  // 2. 启动下载
  try {
    const processObj = downloader.start(status.streamUrl, outputPath, { segmentDuration });
    console.log('[DEBUG] processObj 类型:', typeof processObj);

    setTimeout(() => {
      console.log('\n⏱️  停止录制...');
      if (processObj) {
        processObj.kill('SIGINT');
      }
    }, testDuration * 1000);
  } catch (e) {
    console.error('[DEBUG] 启动下载时捕获到异常:', e);
  }
}

main().catch((err) => {
  console.error('❌ 测试脚本执行失败:', err);
  process.exit(1);
});
