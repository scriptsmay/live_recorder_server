#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const packagePath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

const semverRegex = /^(\d+)\.(\d+)\.(\d+)$/;

// 封装一个等待终端输入的 Promise 函数
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

// 获取两次 tag 之间的 commit 记录
function getRecentCommits() {
  try {
    const lastTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
    const commits = execSync(`git log ${lastTag}..HEAD --pretty=format:"%h - %s"`, { encoding: 'utf8' }).trim();
    return commits || '无新提交';
  } catch (e) {
    // 如果是第一次发版，没有上一个 tag 的兜底
    return execSync('git log --oneline', { encoding: 'utf8' }).trim();
  }
}

// 调用大模型生成 Release Note (以兼容 OpenAI 格式的 API 为例)
async function generateReleaseNoteAI(commits) {
  // 从环境变量中获取 API Key
  const apiKey = process.env.DEEPSEEK_API_KEY;

  // 增加一道安全校验，防止没配变量直接运行报错
  if (!apiKey) {
    console.warn('⚠️ 警告: 未检测到 DEEPSEEK_API_KEY 环境变量，跳过 AI 生成。');
    return null;
  }

  console.log('🤖 正在呼叫 AI 总结 Changelog...');

  const prompt = `你是一个只输出最终结果的纯文本转换器。请将以下 git commits 整理为面向用户的 Release Note。
【绝对规则】：
1. 严禁任何开场白、寒暄或结尾提示（绝对不要输出“以下是”、“根据提供”、“已过滤”、“如有需要”等废话）。
2. 第一行必须直接以“✨ 新特性”、“🐛 问题修复”或“🔧 优化”开头。
3. 绝对不要使用 \`\`\`markdown 等代码块包裹内容。
4. 不要自己发明主标题。

commits 记录如下：\n${commits}`;

  try {
    // 这里以 DeepSeek 或本地 Ollama 为例，如果是 Gemini 换成对应的 endpoint 和 payload 即可
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      // 换成你的目标 API 地址
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`, // 替换为你的 API Key
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      }),
    });

    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error('AI 生成失败，回退到普通模式:', error.message);
    return null;
  }
}

function bumpVersion(currentVersion, type) {
  const match = currentVersion.match(semverRegex);
  if (!match) {
    throw new Error('Invalid version format');
  }

  let [major, minor, patch] = match.slice(1).map(Number);

  switch (type) {
    case 'patch':
      patch++;
      break;
    case 'minor':
      minor++;
      patch = 0;
      break;
    case 'major':
      major++;
      minor = 0;
      patch = 0;
      break;
    default:
      throw new Error('Invalid version type. Use: patch, minor, or major');
  }

  return `${major}.${minor}.${patch}`;
}

function runCommand(cmd) {
  console.log(`$ ${cmd}`);
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'inherit' });
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    process.exit(1);
  }
}

function checkGitStatus() {
  const status = execSync('git status --porcelain', { encoding: 'utf8' });
  if (status.trim()) {
    console.error('Working tree is not clean. Please commit or stash changes first.');
    process.exit(1);
  }
}

function cleanupOldTags() {
  const tags = execSync("git tag --list 'v*'", { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((t) => t.trim());

  const versionTags = tags
    .filter((t) => semverRegex.test(t.slice(1)))
    .map((t) => ({ tag: t, ver: t.slice(1) }))
    .sort((a, b) => {
      const [aM, am, ap] = a.ver.split('.').map(Number);
      const [bM, bm, bp] = b.ver.split('.').map(Number);
      return bM - aM || bm - am || bp - ap;
    });

  const KEEP = 5;
  if (versionTags.length <= KEEP) return [];

  const toDelete = versionTags.slice(KEEP);
  console.log(`\n--- Cleaning up old tags (keeping latest ${KEEP}) ---`);
  for (const { tag } of toDelete) {
    execSync(`git tag -d ${tag}`, { encoding: 'utf8', stdio: 'inherit' });
  }
  return toDelete.map((t) => t.tag);
}

async function main() {
  const args = process.argv.slice(2);
  const versionType = args[0];

  if (!versionType || !['patch', 'minor', 'major'].includes(versionType)) {
    console.log(`Usage: node ${path.basename(__filename)} <patch|minor|major>`);
    console.log(`Current version: ${packageJson.version}`);
    process.exit(1);
  }

  console.log('=== Live Recorder Server Release Script ===');
  console.log(`Current version: ${packageJson.version}`);

  checkGitStatus();

  const newVersion = bumpVersion(packageJson.version, versionType);
  console.log(`New version: ${newVersion}`);

  // 1. 获取近期 commit
  const rawCommits = getRecentCommits();

  // 2. 尝试用 AI 生成摘要
  let aiSummary = await generateReleaseNoteAI(rawCommits);

  // 3. 打印 AI 结果，并给人工一次确认或修改的机会
  if (aiSummary) {
    console.log('\n--- AI 建议的 Release Note ---');
    console.log(aiSummary);
    console.log('------------------------------\n');
  }

  const userNote = await askQuestion('请确认或输入更新说明 (回车默认使用AI结果/默认格式): ');

  // 决定最终的 tag 信息
  let finalMessage = userNote || aiSummary || `Release v${newVersion}`;
  // 注意：git tag -m 如果内容包含换行，最好把内容写入一个临时文件，再用 git tag -F 引用
  fs.writeFileSync('.tag_tmp', finalMessage);

  packageJson.version = newVersion;
  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');

  console.log('\n--- Committing changes ---');
  runCommand(`git add ${packagePath}`);
  runCommand(`git commit -m "chore: bump version to v${newVersion}"`);

  console.log('\n--- Creating tag ---');
  runCommand(`git tag -a v${newVersion} -F .tag_tmp`);
  fs.unlinkSync('.tag_tmp'); // 用完删掉临时文件

  const deletedTags = cleanupOldTags();

  console.log('\n=== Release complete! ===');
  console.log('Next steps:');
  console.log(`  git push origin $(git rev-parse --abbrev-ref HEAD)`);
  console.log(`  git push origin v${newVersion}`);
  if (deletedTags.length) {
    console.log(`  git push origin --delete ${deletedTags.join(' ')}`);
  }
}

main();
