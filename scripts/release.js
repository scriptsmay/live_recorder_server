#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const packagePath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

const semverRegex = /^(\d+)\.(\d+)\.(\d+)$/;

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

function main() {
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

  packageJson.version = newVersion;
  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');

  console.log('\n--- Committing changes ---');
  runCommand(`git add ${packagePath}`);
  runCommand(`git commit -m "chore: bump version to v${newVersion}"`);

  console.log('\n--- Creating tag ---');
  runCommand(`git tag -a v${newVersion} -m "Release v${newVersion}"`);

  console.log('\n=== Release complete! ===');
  console.log('Next steps:');
  console.log(`  git push origin $(git rev-parse --abbrev-ref HEAD)`);
  console.log(`  git push origin v${newVersion}`);
}

main();
