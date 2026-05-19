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
  let testDuration = 30;
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

  console.log('=== 虎牙 Python 下载器测试 ===');
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

  let buildArgs;
  if (useDirectStreamUrl) {
    console.log('使用直接流 URL 模式');
    buildArgs = downloader.buildArgs(status.streamUrl, outputPath, {
      quality: testQuality,
      maxRetries,
      segmentDuration,
    });
  } else {
    console.log('不支持房间直连模式');
    process.exit(1);
  }

  console.log('构建的参数:', buildArgs);
  console.log('Python 命令: python3 ' + buildArgs.join(' '));
  console.log();

  console.log(`[3/3] 开始测试录制（${testDuration}秒）...`);
  let startTime = Date.now();
  let lastProgressTime = 0;

  const processObj = downloader.spawn(buildArgs);

  processObj.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        console.log('[stderr]', line);
      }

      const progress = downloader.parseProgress(line);
      if (progress) {
        if (progress.timeSeconds !== undefined && progress.timeSeconds !== lastProgressTime) {
          lastProgressTime = progress.timeSeconds;
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          let progressStr = `\r[${elapsed}s] 录制进度: ${Math.floor(progress.timeSeconds)}秒`;
          if (progress.sizeBytes !== undefined) {
            const sizeMB = (progress.sizeBytes / 1024 / 1024).toFixed(2);
            progressStr += ` | 大小: ${sizeMB} MB`;
          }
          if (progress.speed !== undefined) {
            progressStr += ` | 速度: ${progress.speed}x`;
          }
          if (progress.frames !== undefined) {
            progressStr += ` | 帧数: ${progress.frames}`;
          }
          process.stdout.write(progressStr);
        }
      }
    }
  });

  processObj.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        console.log('[stdout]', line);
      }
    }
  });

  processObj.on('error', (err) => {
    console.error('\n❌ 进程启动失败:', err.message);
    process.exit(1);
  });

  processObj.on('close', (code, signal) => {
    console.log('\n');
    if (code === 0) {
      console.log('✅ 下载测试成功！');
      console.log(`输出文件: ${outputPath}`);
      if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`文件大小: ${sizeMB} MB`);
      }
    } else {
      console.log(`❌ 进程退出，代码: ${code}，信号: ${signal}`);

      const strategy = downloader.getRetryStrategy(code);
      console.log(`重试策略:`, strategy);
    }
    process.exit(code);
  });

  setTimeout(() => {
    console.log('\n⏱️  到达预设时间，停止录制...');
    processObj.kill('SIGINT');
  }, testDuration * 1000);
}

main().catch((err) => {
  console.error('❌ 测试脚本执行失败:', err);
  process.exit(1);
});
