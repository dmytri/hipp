#!/usr/bin/env node
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const semver = require('semver');
const readline = require('readline');
const os = require('os');

const log = {
  error: (msg) => console.error(`\x1b[31m${msg}\x1b[0m`),
  info: (msg) => console.log(`\x1b[36m${msg}\x1b[0m`),
  success: (msg) => console.log(`\x1b[32m${msg}\x1b[0m`),
  warn: (msg) => console.warn(`\x1b[33m${msg}\x1b[0m`),
};

function fail(msg) {
  log.error(msg);
  process.exit(1);
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function getVersionFromGit() {
  try {
    const rawTag = git(['describe', '--tags', '--exact-match']);
    if (!rawTag.startsWith('v')) {
      throw new Error(`tag "${rawTag}" must start with "v"`);
    }
    const clean = semver.clean(rawTag);
    if (!clean) {
      throw new Error(`tag "${rawTag}" is not valid semver`);
    }
    return clean;
  } catch (err) {
    fail(`❌ Integrity Error: ${err.message}`);
  }
}

function ensureCleanRepo(pkg) {
  if (pkg.version !== '0.0.0') {
    fail('❌ Integrity Violation: package.json version must be 0.0.0');
  }

  if (pkg.workspaces) {
    fail('❌ Workspace Error: HIPP currently only supports single-package repositories.');
  }

  const status = git(['status', '--porcelain']);
  if (status) {
    fail('❌ Integrity Error: Uncommitted changes found.');
  }
}

function getTrackedFiles() {
  const out = git(['ls-files', '-z']);
  return out.split('\0').filter(Boolean);
}

function safeStageName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function copyTrackedFiles(stageDir, files) {
  const repoRoot = process.cwd();

  for (const rel of files) {
    const src = path.join(repoRoot, rel);
    const dest = path.join(stageDir, rel);
    const stat = fs.lstatSync(src);

    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(src);
      fs.symlinkSync(target, dest);
    } else if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
    } else if (stat.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
}

async function confirmPrompt(name, version) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await new Promise((resolve) => {
      rl.question(`🚀 Confirm launch of ${name}@${version}? [y/N] `, resolve);
    });
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function run() {
  const args = process.argv.slice(2);
  const sep = args.indexOf('--');
  const hippArgs = sep !== -1 ? args.slice(0, sep) : args;
  const npmArgs = sep !== -1 ? args.slice(sep + 1) : [];
  const skipPrompt = hippArgs.includes('--yes') || hippArgs.includes('-y');

  const pkgPath = path.resolve(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fail('❌ Error: No package.json found.');
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  ensureCleanRepo(pkg);

  const version = getVersionFromGit();
  const trackedFiles = getTrackedFiles();

  log.info('🚀 HIPP: High Integrity Package Publisher');
  log.success(`🏷️  Git Tag Truth: v${version}`);

  if (!skipPrompt) {
    const confirmed = await confirmPrompt(pkg.name, version);
    if (!confirmed) {
      log.warn('Aborted.');
      process.exit(0);
    }
  }

  const stageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `hipp-${safeStageName(pkg.name)}-`)
  );

  try {
    log.info(`🏗️  Staging tracked files to ${stageDir}...`);
    copyTrackedFiles(stageDir, trackedFiles);

    const stagedPkgPath = path.join(stageDir, 'package.json');
    const stagedPkg = JSON.parse(fs.readFileSync(stagedPkgPath, 'utf8'));
    stagedPkg.version = version;
    fs.writeFileSync(stagedPkgPath, JSON.stringify(stagedPkg, null, 2) + '\n');

    log.info('🔥 Ignition...');

    const result = spawnSync('npm', ['publish', ...npmArgs], {
      cwd: stageDir,
      stdio: 'inherit',
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(`npm publish exited with code ${result.status}`);
    }

    log.success(`\n✨ Success! Published ${pkg.name}@${version}`);
  } catch (err) {
    fail(`\n💥 Launch failed: ${err.message}`);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
    log.info('🧹 Off-site staging cleared. Source integrity preserved.');
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`\x1b[36mHIPP - High Integrity Package Publisher\x1b[0m

Usage:
  npx hipp [options] [-- npm-options]

Options:
  -y, --yes   Skip confirmation prompt
  -h, --help  Show this help

Integrity rules:
  - package.json version must be 0.0.0
  - repository must be clean
  - HEAD must have an exact v-prefixed semver tag
  - only git-tracked files are staged
  - only staged package.json is rewritten`);
} else {
  run();
}

