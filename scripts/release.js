#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('../config/env').initEnv();

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

// 调用大模型生成 Release Note (支持 LiteLLM 格式配置)
async function generateReleaseNoteAI(commits) {
  // 从环境变量中获取 AI 配置
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE || 'https://api.deepseek.com';
  const aiModel = process.env.AI_MODEL || 'deepseek/deepseek-v4-flash';

  // 提取模型名称（兼容 LiteLLM 格式 provider/model_name）
  const model = aiModel.includes('/') ? aiModel.split('/')[1] : aiModel;

  // 增加一道安全校验，防止没配变量直接运行报错
  if (!apiKey) {
    console.warn('⚠️ 警告: 未检测到 AI_API_KEY 环境变量，跳过 AI 生成。');
    return null;
  }
  console.log(`🤖 正在使用 AI 模型 "${model}" 生成 Release Note...`);

  const prompt = `
你是一个精简、专业的技术文档撰写助手。请将输入的 Git commits 整理为面向用户的 Release Note。

【处理逻辑】：
1. 语义归纳：合并相似的提交（例如：将多个针对同一模块的修复合并为一条），提取核心意图。
2. 内容润色：将 commit message 的技术用语转化为用户易懂的自然语言。

【格式要求】：
1. 绝对禁止任何开场白、结尾或代码块包裹（直接输出纯文本）。
2. 使用以下分类进行归纳，若分类下无内容则忽略该分类：
   ✨ 新特性：新增功能或重要的 API 变更。
   🐛 问题修复：修复 Bug 或异常行为。
   🔧 优化：性能提升、重构、依赖更新或开发者体验提升。
3. 每一项内容保持单行，句式简洁（如：“修复了由于 XXX 导致的 YYY 问题”）。

【输入数据】：
${commits}
`;

  try {
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('AI API 请求失败:', response.status, response.statusText, errorData);
      return null;
    }

    const data = await response.json();
    if (!data.choices || data.choices.length === 0) {
      console.error('AI 返回数据格式异常:', data);
      return null;
    }
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
  const versionType = args.find((arg) => ['patch', 'minor', 'major'].includes(arg));
  const isAuto = args.includes('--auto');

  if (!versionType) {
    console.log(`Usage: node ${path.basename(__filename)} <patch|minor|major> [--auto]`);
    console.log(`  --auto  跳过确认，直接使用 AI 生成的 Release Note`);
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
    console.log('------ AI 建议的 Release Note ------');
    console.log(aiSummary);
    console.log('-------------------------------------\n');
  }

  let finalMessage;
  if (isAuto) {
    finalMessage = aiSummary || `Release v${newVersion}`;
    console.log(`\n--- 自动模式，直接使用 AI 结果 ---`);
  } else {
    const userNote = await askQuestion('请确认或输入更新说明 (回车默认使用AI结果/默认格式): ');
    finalMessage = userNote || aiSummary || `Release v${newVersion}`;
  }
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
