#!/usr/bin/env node
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const semver = require('semver');
const readline = require('readline');
const os = require('os');
const crypto = require('crypto');

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

function runCmd(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });

  if (result.error) throw result.error;
  return result;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function safeStageName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function getVersionFromExactTagOnHead() {
  try {
    const rawTag = git(['describe', '--tags', '--exact-match', 'HEAD']);
    if (!rawTag.startsWith('v')) {
      throw new Error(`tag "${rawTag}" must start with "v"`);
    }
    const clean = semver.clean(rawTag);
    if (!clean) {
      throw new Error(`tag "${rawTag}" is not valid semver`);
    }
    return { rawTag, version: clean };
  } catch (err) {
    fail(`❌ Integrity Error: HEAD must have an exact v-prefixed semver tag. ${err.message}`);
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

function ensureMutableRefPolicy() {
  let branch;
  try {
    branch = git(['symbolic-ref', '--short', 'HEAD']);
  } catch {
    fail('❌ Ref Error: Detached HEAD is not allowed for publish.');
  }

  let upstream;
  try {
    upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    fail(`❌ Ref Error: Branch "${branch}" must track an upstream branch.`);
  }

  const head = git(['rev-parse', 'HEAD']);
  const upstreamHead = git(['rev-parse', '@{u}']);

  if (head !== upstreamHead) {
    fail(`❌ Ref Error: HEAD (${head.slice(0, 12)}) must exactly match upstream (${upstream} ${upstreamHead.slice(0, 12)}).`);
  }

  return { branch, upstream, head };
}

function ensureRemoteProvenance(rawTag, headSha) {
  let remoteUrl;
  try {
    remoteUrl = git(['remote', 'get-url', 'origin']);
  } catch {
    fail('❌ Provenance Error: Remote "origin" is required.');
  }

  const tagObjectLocal = git(['rev-parse', rawTag]);
  const tagCommitLocal = git(['rev-list', '-n', '1', rawTag]);

  const remoteTagObject = git(['ls-remote', '--tags', 'origin', `refs/tags/${rawTag}`])
    .split('\t')[0]
    .trim();

  const remoteTagCommit = git(['ls-remote', '--tags', 'origin', `refs/tags/${rawTag}^{}`])
    .split('\t')[0]
    .trim();

  if (!remoteTagObject) {
    fail(`❌ Provenance Error: Tag "${rawTag}" does not exist on origin (${remoteUrl}).`);
  }

  if (remoteTagObject !== tagObjectLocal) {
    fail(`❌ Provenance Error: Local tag object for "${rawTag}" does not match origin.`);
  }

  if (remoteTagCommit && remoteTagCommit !== tagCommitLocal) {
    fail(`❌ Provenance Error: Local tag target commit for "${rawTag}" does not match origin.`);
  }

  const remoteContains = runCmd('git', ['branch', '-r', '--contains', headSha], {
    encoding: 'utf8',
  });

  if (remoteContains.status !== 0) {
    fail('❌ Provenance Error: Could not verify remote containment for HEAD.');
  }

  const remoteBranches = remoteContains.stdout
    .split('\n')
    .map((s) => s.trim().replace(/^\* /, ''))
    .filter(Boolean);

  const onOrigin = remoteBranches.some((b) => b.startsWith('origin/'));
  if (!onOrigin) {
    fail('❌ Provenance Error: HEAD commit is not contained in any origin remote branch.');
  }

  return { remoteUrl };
}

function ensureLockIntegrity(pkg) {
  const lockPath = path.join(process.cwd(), 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    fail('❌ Lock Error: package-lock.json is required.');
  }

  try {
    git(['ls-files', '--error-unmatch', 'package-lock.json']);
  } catch {
    fail('❌ Lock Error: package-lock.json must be tracked by git.');
  }

  const pkgJsonRaw = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
  const lockJsonRaw = fs.readFileSync(lockPath, 'utf8');

  let lock;
  try {
    lock = JSON.parse(lockJsonRaw);
  } catch {
    fail('❌ Lock Error: package-lock.json is not valid JSON.');
  }

  if (!lock.name || !lock.version) {
    fail('❌ Lock Error: package-lock.json is missing top-level name/version.');
  }

  if (lock.name !== pkg.name) {
    fail(`❌ Lock Error: package-lock.json name mismatch. Expected ${pkg.name}, got ${lock.name}.`);
  }

  if (lock.version !== pkg.version) {
    fail(`❌ Lock Error: package-lock.json version mismatch. Expected ${pkg.version}, got ${lock.version}.`);
  }

  const ciCheck = runCmd('npm', ['ci', '--ignore-scripts', '--dry-run'], {
    cwd: process.cwd(),
    env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
  });

  if (ciCheck.status !== 0) {
    process.stderr.write(ciCheck.stderr || '');
    fail('❌ Lock Error: `npm ci --ignore-scripts --dry-run` failed.');
  }

  return {
    lockfileSha256: sha256(lockJsonRaw),
    packageJsonSha256: sha256(pkgJsonRaw),
  };
}

function getTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'buffer',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
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

  const { rawTag, version } = getVersionFromExactTagOnHead();
  const refInfo = ensureMutableRefPolicy();
  const provenance = ensureRemoteProvenance(rawTag, refInfo.head);
  const lockInfo = ensureLockIntegrity(pkg);
  const trackedFiles = getTrackedFiles();

  log.info('🚀 HIPP: High Integrity Package Publisher');
  log.success(`🏷️  Git Tag Truth: ${rawTag}`);
  log.success(`🌿 Ref Truth: ${refInfo.branch} == ${refInfo.upstream}`);
  log.success(`🌍 Origin Truth: ${provenance.remoteUrl}`);
  log.success(`🔒 Lock Truth: ${lockInfo.lockfileSha256.slice(0, 12)}…`);

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
      env: {
        ...process.env,
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      },
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
  - package-lock.json must exist and be tracked
  - npm ci --ignore-scripts --dry-run must succeed
  - repository must be clean
  - HEAD must be on a branch with an upstream
  - HEAD must exactly match upstream
  - HEAD must have an exact v-prefixed semver tag
  - the exact tag must exist on origin and match locally
  - HEAD commit must be contained in an origin remote branch
  - only git-tracked files are staged
  - only staged package.json is rewritten`);
} else {
  run();
}
