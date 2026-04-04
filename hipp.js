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

function getPrivateKeyPath() {
  return path.join(process.cwd(), 'hipp.priv');
}

function getPublicKeyPath() {
  return path.join(process.cwd(), 'hipp.pub');
}

function generateKeyPair() {
  const { generateKeyPairSync } = crypto;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

function loadOrGenerateKeys() {
  const privPath = getPrivateKeyPath();
  const pubPath = getPublicKeyPath();

  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    return {
      privateKey: fs.readFileSync(privPath, 'utf8'),
      publicKey: fs.readFileSync(pubPath, 'utf8'),
    };
  }

  log.info('🔑 Generating Ed25519 keypair...');
  const { privateKey, publicKey } = generateKeyPair();

  fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey);

  log.success('🔑 Keypair generated.');

  const gitignorePath = path.join(process.cwd(), '.gitignore');
  let gitignore = '';
  if (fs.existsSync(gitignorePath)) {
    gitignore = fs.readFileSync(gitignorePath, 'utf8');
  }
  if (!gitignore.includes('hipp.priv')) {
    fs.writeFileSync(gitignorePath, gitignore.trimEnd() + '\nhipp.priv\n');
    log.info('📝 Added hipp.priv to .gitignore');
  }

  return { privateKey, publicKey };
}

function signContent(data, privateKey) {
  const signature = crypto.sign(null, Buffer.from(data), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return signature.toString('base64');
}

function verifySignature(data, signature, publicKey) {
  const verify = crypto.verify;
  return verify(null, Buffer.from(data), {
    key: publicKey,
    dsaEncoding: 'ieee-p1363',
  }, Buffer.from(signature, 'base64'));
}

function createManifest(hash, signature) {
  return Buffer.from(JSON.stringify({ hash, signature })).toString('base64');
}

function parseManifest(manifestBase64) {
  try {
    return JSON.parse(Buffer.from(manifestBase64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function buildSignData(hash, origin, tag) {
  return `${hash}\n${origin}\n${tag}\n`;
}

const MANIFEST_START = '<!-- HIPP-MANIFEST -->';
const MANIFEST_END = '<!-- /HIPP-MANIFEST -->';

function appendManifestToReadme(readmeContent, manifest) {
  return `${readmeContent}${MANIFEST_START}\`\`\`${manifest}\`\`\`${MANIFEST_END}\n`;
}

function extractManifestFromReadme(readmeContent) {
  const startIdx = readmeContent.indexOf(MANIFEST_START);
  if (startIdx === -1) return null;
  const endIdx = readmeContent.indexOf(MANIFEST_END, startIdx);
  if (endIdx === -1) return null;
  const content = readmeContent.slice(startIdx + MANIFEST_START.length, endIdx).trim();
  const match = content.match(/^```(.+)```$/s);
  if (!match) return null;
  return match[1];
}

function stripManifestFromReadme(readmeContent) {
  const startIdx = readmeContent.indexOf(MANIFEST_START);
  const endIdx = readmeContent.indexOf(MANIFEST_END, startIdx);
  if (startIdx === -1 || endIdx === -1) return readmeContent;

  const endLineIdx = readmeContent.indexOf('\n', endIdx);
  const endOfManifest = endLineIdx !== -1 ? endLineIdx + 1 : readmeContent.length;

  const beforeWithNewline = readmeContent.slice(0, startIdx);
  const lastNewlineBefore = beforeWithNewline.lastIndexOf('\n');
  const before = lastNewlineBefore !== -1 ? beforeWithNewline.slice(0, lastNewlineBefore) : beforeWithNewline;

  const after = readmeContent.slice(endOfManifest);
  return before + '\n' + after;
}

function computeReadmeHash(readmeContent) {
  const stripped = stripManifestFromReadme(readmeContent);
  return sha256(stripped);
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

async function runVerify(packageSpec) {
  const [pkgName, pkgVersion] = packageSpec.split('@');
  log.info(`🔍 HIPP Verify: ${pkgName}${pkgVersion ? '@' + pkgVersion : ''}`);

  const registryUrl = 'https://registry.npmjs.org';
  const fetchUrl = `${registryUrl}/${encodeURIComponent(pkgName)}/${pkgVersion ? pkgVersion : 'latest'}`;

  log.info(`📦 Fetching from npm...`);
  let tarballUrl;
  try {
    const fetchResult = runCmd('curl', ['-s', '-L', '-w', '%{url_effective}', '-o', '/dev/null', fetchUrl]);
    tarballUrl = fetchResult.stdout.trim();
  } catch {
    fail(`❌ Failed to fetch package info for ${pkgName}`);
  }

  const tarballPath = path.join(os.tmpdir(), `hipp-verify-${safeStageName(pkgName)}-tgz`);
  try {
    log.info(`📦 Downloading tarball...`);
    const curlResult = runCmd('curl', ['-s', '-L', '-o', tarballPath, tarballUrl]);
    if (curlResult.status !== 0) {
      fail(`❌ Failed to download tarball`);
    }

    log.info(`📦 Extracting tarball...`);
    runCmd('tar', ['-xzf', tarballPath, '-C', os.tmpdir()], { stdio: 'pipe' });

    const packageDir = path.join(os.tmpdir(), 'package');
    const stagedReadmePath = path.join(packageDir, 'README.md');

    if (!fs.existsSync(stagedReadmePath)) {
      fail(`❌ README.md not found in package`);
    }

    const stagedReadme = fs.readFileSync(stagedReadmePath, 'utf8');
    const manifestBase64 = extractManifestFromReadme(stagedReadme);
    if (!manifestBase64) {
      fail(`❌ Manifest not found in README`);
    }

    const manifest = parseManifest(manifestBase64);
    if (!manifest || !manifest.hash || !manifest.signature) {
      fail(`❌ Invalid manifest format`);
    }

    log.info(`📦 Extracting tarball to staging...`);
    runCmd('tar', ['-xzf', tarballPath, '-C', os.tmpdir()], { stdio: 'pipe' });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `hipp-verify-git-`));
    try {
      log.info(`🌿 Fetching from git origin...`);

      const originUrl = manifest.origin;
      const tag = manifest.tag;

      git(['clone', '--branch', tag, '--depth', '1', originUrl, tmpDir], { stdio: 'pipe' });

      const clonedReadmePath = path.join(tmpDir, 'README.md');
      if (!fs.existsSync(clonedReadmePath)) {
        fail(`❌ README.md not found in git at tag ${tag}`);
      }

      const clonedReadme = fs.readFileSync(clonedReadmePath, 'utf8');
      const clonedHash = computeReadmeHash(clonedReadme);

      if (clonedHash !== manifest.hash) {
        fail(`❌ Hash mismatch: git content does not match npm manifest`);
      }

      log.success(`🔒 Content hash verified: ${manifest.hash.slice(0, 12)}...`);

      const publicKeyPath = path.join(tmpDir, 'hipp.pub');
      if (!fs.existsSync(publicKeyPath)) {
        fail(`❌ hipp.pub not found in git at tag ${tag}`);
      }

      const publicKey = fs.readFileSync(publicKeyPath, 'utf8');
      const signData = buildSignData(manifest.hash, originUrl, tag);
      const signatureValid = verifySignature(signData, manifest.signature, publicKey);

      if (!signatureValid) {
        fail(`❌ Signature verification failed`);
      }

      log.success(`🔏 Signature verified`);
      log.success(`✅ Package ${pkgName} verified successfully!`);
      log.info(`📍 Origin: ${originUrl}`);
      log.info(`📍 Tag: ${tag}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tarballPath, { recursive: true, force: true });
    const packageExtractDir = path.join(os.tmpdir(), 'package');
    if (fs.existsSync(packageExtractDir)) {
      fs.rmSync(packageExtractDir, { recursive: true, force: true });
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

  loadOrGenerateKeys();

  const pubPath = getPublicKeyPath();
  try {
    git(['ls-files', '--error-unmatch', 'hipp.pub']);
  } catch {
    log.info('📝 Committing hipp.pub to repo...');
    git(['add', 'hipp.pub']);
    git(['commit', '-m', 'Add hipp public key for package signing']);
    log.success('📝 hipp.pub committed.');
  }

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

    const { privateKey } = loadOrGenerateKeys();

    const stagedPkgPath = path.join(stageDir, 'package.json');
    const stagedPkg = JSON.parse(fs.readFileSync(stagedPkgPath, 'utf8'));
    stagedPkg.version = version;
    fs.writeFileSync(stagedPkgPath, JSON.stringify(stagedPkg, null, 2) + '\n');

    const stagedReadmePath = path.join(stageDir, 'README.md');
    let stagedReadme = '';
    if (fs.existsSync(stagedReadmePath)) {
      stagedReadme = fs.readFileSync(stagedReadmePath, 'utf8');
    }

    stagedReadme += '\n```json\n{\n  "origin": "' + provenance.remoteUrl + '",\n  "tag": "' + rawTag + '"\n}\n```\n\n```npx @dk/hipp ' + pkg.name + '@' + version + '```\n\n';

    const readmeHash = computeReadmeHash(stagedReadme);
    const dataToSign = buildSignData(readmeHash, provenance.remoteUrl, rawTag);
    const signature = signContent(dataToSign, privateKey);
    const manifest = createManifest(readmeHash, signature);
    stagedReadme = appendManifestToReadme(stagedReadme, manifest);

    fs.writeFileSync(stagedReadmePath, stagedReadme);

    log.success('🔏 Manifest signed.');

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

const isVerify = process.argv.includes('verify');
const verifyIndex = process.argv.indexOf('verify');
const packageSpec = verifyIndex !== -1 ? process.argv[verifyIndex + 1] : null;

if (isVerify && packageSpec) {
  runVerify(packageSpec);
} else if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`\x1b[36mHIPP - High Integrity Package Publisher\x1b[0m

Usage:
  npx hipp [options] [-- npm-options]
  npx hipp verify <package>[@version]

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
