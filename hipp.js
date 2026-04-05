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

function getGitUserInfo() {
  const name = git(['config', 'user.name']);
  const email = git(['config', 'user.email']);
  return { name, email };
}

function sshToHttpsUrl(sshUrl) {
  const match = sshUrl.match(/^git@([^:]+):(.+\.git)$/);
  if (match) {
    return `https://${match[1]}/${match[2]}`;
  }
  return sshUrl;
}

function httpsToSshUrl(httpsUrl) {
  const match = httpsUrl.match(/^https:\/\/([^/]+)\/(.+)$/);
  if (match) {
    return `git@${match[1]}:${match[2]}`;
  }
  return httpsUrl;
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
    const privateKey = fs.readFileSync(privPath, 'utf8');
    const publicKey = fs.readFileSync(pubPath, 'utf8');

    const testData = 'hipp-key-validation';
    const testSignature = signContent(testData, privateKey);
    const valid = verifySignature(testData, testSignature, publicKey);

    if (valid) {
      return { privateKey, publicKey };
    }

    log.warn('⚠️  Key mismatch detected. Generating new keypair...');
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

function buildSignData(hash, origin, tag, revision, name, email) {
  return `${hash}\n${origin}\n${tag}\n${revision}\n${name}\n${email}\n`;
}

function findLastJsonBlock(readmeContent) {
  const lines = readmeContent.split('\n');
  let jsonStart = -1;
  let braceCount = 0;
  let inJson = false;
  let lastValid = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '```json') {
      jsonStart = i + 1;
      inJson = true;
      braceCount = 0;
      continue;
    }
    if (inJson) {
      for (const char of line) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
      }
      if (braceCount === 0 && line.includes('}')) {
        const jsonStr = lines.slice(jsonStart, i + 1).join('\n');
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.origin && parsed.tag && parsed.hash && parsed.signature) {
            lastValid = parsed;
          }
        } catch {
          // continue searching
        }
        inJson = false;
      }
    }
  }
  return lastValid;
}

function packAndHash(stageDir) {
  const result = spawnSync('npm', ['pack'], {
    cwd: stageDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(`npm pack failed: ${result.stderr}`);
  }

  const tarballName = result.stdout.trim().split('\n').pop();
  const tarballPath = path.join(stageDir, tarballName);

  const tarballContent = fs.readFileSync(tarballPath);
  fs.unlinkSync(tarballPath);

  return { tarballName, tarballHash: sha256(tarballContent) };
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

function getTrackedFilesFromDir(repoDir) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'buffer',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: repoDir,
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

function copyTrackedFilesFromDir(stageDir, repoDir, files) {
  for (const rel of files) {
    const src = path.join(repoDir, rel);
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
  const npa = require('npm-package-arg');
  const parsed = npa(packageSpec);
  const pkgName = parsed.name;
  const pkgVersion = parsed.fetchSpec;
  log.info(`🔍 HIPP Verify: ${pkgName}${pkgVersion ? '@' + pkgVersion : ''}`);

  const registryUrl = `https://registry.npmjs.org/${parsed.escapedName}/${pkgVersion || 'latest'}`;

  log.info(`📦 Fetching manifest from npm...`);
  const registryJson = runCmd('curl', ['-s', '-L', registryUrl]);
  let tarballUrl;
  let manifest;
  try {
    const json = JSON.parse(registryJson.stdout.trim());
    tarballUrl = json.dist.tarball;
  } catch {
    fail(`❌ Failed to parse npm registry response for ${pkgName}`);
  }

  const tarballPath = path.join(os.tmpdir(), `hipp-verify-${safeStageName(pkgName)}-tgz`);
  const extractDir = path.join(os.tmpdir(), `hipp-verify-extract-${safeStageName(pkgName)}`);

  try {
    log.info(`📦 Downloading tarball from ${tarballUrl}...`);
    const curlResult = runCmd('curl', ['-s', '-L', '-o', tarballPath, tarballUrl]);
    if (curlResult.status !== 0) {
      fail(`❌ Failed to download tarball`);
    }

    const npmTarballContent = fs.readFileSync(tarballPath);
    const npmHash = sha256(npmTarballContent);
    log.success(`📦 NPM tarball hash: ${npmHash.slice(0, 12)}...`);

    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true });
    }
    fs.mkdirSync(extractDir, { recursive: true });

    log.info(`📦 Extracting tarball...`);
    const tarResult = spawnSync('tar', ['-xzf', tarballPath, '-C', extractDir], { encoding: 'utf8', stdio: 'pipe' });
    if (tarResult.status !== 0) {
      fail(`❌ Failed to extract tarball: ${tarResult.stderr}`);
    }

    const packageDir = path.join(extractDir, 'package');
    const npmReadmePath = path.join(packageDir, 'README.md');

    if (!fs.existsSync(npmReadmePath)) {
      fail(`❌ README.md not found in npm package`);
    }

    const npmReadme = fs.readFileSync(npmReadmePath, 'utf8');
    manifest = findLastJsonBlock(npmReadme);
    if (!manifest || !manifest.origin || !manifest.tag || !manifest.revision || !manifest.hash || !manifest.signature || !manifest.name || !manifest.email) {
      fail(`❌ Manifest not found or invalid in README`);
    }

    const { origin: originUrl, tag, revision, signature, name, email, npm: npmVer, node: nodeVer, hipp: hippVer } = manifest;

    log.info(`🌿 Cloning git origin at tag ${tag}...`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `hipp-verify-git-`));
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), `hipp-verify-stage-`));

    try {
      let cloneResult;
      try {
        cloneResult = git(['clone', '--branch', tag, '--depth', '1', originUrl, tmpDir], { stdio: 'pipe' });
      } catch (cloneErr) {
        if (originUrl.startsWith('git@')) {
          const httpsUrl = sshToHttpsUrl(originUrl);
          log.info(`🌿 SSH clone failed, trying HTTPS: ${httpsUrl}...`);
          cloneResult = git(['clone', '--branch', tag, '--depth', '1', httpsUrl, tmpDir], { stdio: 'pipe' });
        } else {
          throw cloneErr;
        }
      }

      const clonedRevision = git(['rev-parse', 'HEAD'], { cwd: tmpDir });
      if (clonedRevision !== revision) {
        fail(`❌ Revision mismatch: manifest claims ${revision.slice(0, 12)} but tag points to ${clonedRevision.slice(0, 12)}`);
      }
      log.success(`🏷️  Revision verified: ${revision.slice(0, 12)}...`);

      const publicKeyPath = path.join(tmpDir, 'hipp.pub');
      if (!fs.existsSync(publicKeyPath)) {
        fail(`❌ hipp.pub not found in git at tag ${tag}`);
      }

      const publicKey = fs.readFileSync(publicKeyPath, 'utf8');

      log.info(`🏗️  Staging git files...`);
      const trackedFiles = getTrackedFilesFromDir(tmpDir);
      copyTrackedFilesFromDir(stageDir, tmpDir, trackedFiles);

      log.info(`📦 Packing clean git files...`);
      const { tarballHash: cleanHash } = packAndHash(stageDir);
      log.success(`📦 Clean hash: ${cleanHash.slice(0, 12)}...`);

      log.info(`🔍 Check 2: Verifying manifest hash...`);
      if (cleanHash !== manifest.hash) {
        fail(`❌ Manifest hash mismatch: clean git tarball does not match manifest`);
      }
      log.success(`🔒 Manifest hash verified`);

      log.info(`🔍 Check 1: Verifying signature...`);
      const signData = buildSignData(manifest.hash, originUrl, tag, revision, name, email);
      const signatureValid = verifySignature(signData, signature, publicKey);
      if (!signatureValid) {
        fail(`❌ Signature verification failed`);
      }
      log.success(`🔏 Signature verified`);

      log.info(`🔍 Check 3: Rebuilding from source...`);
      const stagedReadmePath = path.join(stageDir, 'README.md');
      let stagedReadme = fs.readFileSync(stagedReadmePath, 'utf8');
      const tagVersion = semver.clean(tag);
      if (!tagVersion) {
        fail(`❌ Tag ${tag} is not valid semver`);
      }
      stagedReadme = stagedReadme.trimEnd() + '\n\n## Verify\n\n' +
        'Verify this package with [@dk/hipp](https://www.npmjs.com/package/@dk/hipp):\n\n' +
        '```bash\n' +
        `npx @dk/hipp verify ${pkgName}@${tagVersion}\n` +
        '```\n\n' +
        '```json\n' + JSON.stringify(manifest, null, 2) + '\n```\n';
      fs.writeFileSync(stagedReadmePath, stagedReadme);

      const stagedPkgPath = path.join(stageDir, 'package.json');
      const stagedPkg = JSON.parse(fs.readFileSync(stagedPkgPath, 'utf8'));
      stagedPkg.version = tagVersion;
      fs.writeFileSync(stagedPkgPath, JSON.stringify(stagedPkg, null, 2) + '\n');

      const { tarballHash: rebuildHash } = packAndHash(stageDir);
      log.success(`📦 Rebuild hash: ${rebuildHash.slice(0, 12)}...`);

      if (rebuildHash !== npmHash) {
        log.error(`❌ Rebuild mismatch!`);
        log.error(`   NPM tarball:  ${npmHash}`);
        log.error(`   Git rebuild:  ${rebuildHash}`);
        fail(`❌ Package integrity compromised`);
      }
      log.success(`🔄 Rebuild verified`);

      log.success(`✅ Verified: all checks passed`);
      log.info(`📍 Publisher: ${name} <${email}>`);
      log.info(`📍 Origin: ${originUrl}`);
      log.info(`📍 Tag: ${tag}`);
      if (npmVer || nodeVer || hippVer) {
        const parts = [];
        const displayHipp = hippVer === '0.0.0' ? tagVersion : hippVer;
        if (hippVer) parts.push(`hipp: ${displayHipp}`);
        if (npmVer) parts.push(`npm: ${npmVer}`);
        if (nodeVer) parts.push(`node: ${nodeVer}`);
        log.info(`ℹ️  ${parts.join(' | ')}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tarballPath, { recursive: true, force: true });
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
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

  const { rawTag, version } = getVersionFromExactTagOnHead();

  ensureCleanRepo(pkg);

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

    log.info(`📦 Packing to compute content hash...`);
    const { tarballHash } = packAndHash(stageDir);
    log.success(`🔒 Content hash: ${tarballHash.slice(0, 12)}...`);

    const stagedReadmePath = path.join(stageDir, 'README.md');
    let stagedReadme = '';
    if (fs.existsSync(stagedReadmePath)) {
      stagedReadme = fs.readFileSync(stagedReadmePath, 'utf8');
    }

    const { name, email } = getGitUserInfo();
    const revision = refInfo.head;
    const npmVersion = runCmd('npm', ['--version']).stdout.trim();
    const nodeVersion = process.version;
    const hippPkgPath = path.join(path.dirname(process.argv[1]), 'package.json');
    const hippPkg = JSON.parse(fs.readFileSync(hippPkgPath, 'utf8'));
    const hippVersion = hippPkg.version;
    const originUrl = provenance.remoteUrl;
    const dataToSign = buildSignData(tarballHash, originUrl, rawTag, revision, name, email);
    const signature = signContent(dataToSign, privateKey);

    const manifestJson = {
      origin: originUrl,
      tag: rawTag,
      revision: revision,
      hash: tarballHash,
      signature: signature,
      name: name,
      email: email,
      npm: npmVersion,
      node: nodeVersion,
      hipp: hippVersion,
    };

    stagedReadme = stagedReadme.trimEnd() + '\n\n## Verify\n\n' +
      'Verify this package with [@dk/hipp](https://www.npmjs.com/package/@dk/hipp):\n\n' +
      '```bash\n' +
      `npx @dk/hipp verify ${pkg.name}@${version}\n` +
      '```\n\n' +
      '```json\n' + JSON.stringify(manifestJson, null, 2) + '\n```\n';
    fs.writeFileSync(stagedReadmePath, stagedReadme);

    const stagedPkgPath = path.join(stageDir, 'package.json');
    const stagedPkg = JSON.parse(fs.readFileSync(stagedPkgPath, 'utf8'));
    stagedPkg.version = version;
    fs.writeFileSync(stagedPkgPath, JSON.stringify(stagedPkg, null, 2) + '\n');

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

if (isVerify) {
  const specToVerify = packageSpec;
  if (specToVerify) {
    runVerify(specToVerify);
  } else {
    const hippPkgPath = path.join(path.dirname(process.argv[1]), 'package.json');
    const hippPkg = JSON.parse(fs.readFileSync(hippPkgPath, 'utf8'));
    runVerify(`${hippPkg.name}@${hippPkg.version}`);
  }
} else if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`\x1b[36mHIPP - High Integrity Package Publisher\x1b[0m

Usage:
  npx hipp [options] [-- npm-options]
  npx hipp verify [@package[@version]]

  Without arguments, verifies the installed hipp version.

Options:
  -y, --yes   Skip confirmation prompt
  -h, --help  Show this help

Verify: Downloads npm tarball, clones git at tag, runs all three verification checks:
  1. Signature verification (manifest signed by private key)
  2. Manifest hash (clean git tarball matches manifest hash)
  3. Rebuild verification (npm tarball equals git rebuild with manifest+version)

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
