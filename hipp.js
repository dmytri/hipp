#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const semver = require('semver');
const readline = require('readline');

const log = {
  error: (msg) => console.error(`\x1b[31m${msg}\x1b[0m`),
  info: (msg) => console.log(`\x1b[36m${msg}\x1b[0m`),
  success: (msg) => console.log(`\x1b[32m${msg}\x1b[0m`),
  warn: (msg) => console.warn(`\x1b[33m${msg}\x1b[0m`),
};

if (typeof semver.valid !== 'function') {
  log.error("❌ Compatibility Error: 'semver' package API mismatch.");
  process.exit(1);
}

function getVersionFromGit() {
  try {
    const rawTag = execSync('git describe --tags --abbrev=0', { stdio: ['pipe', 'pipe', 'ignore'] })
      .toString().trim();
    
    if (!rawTag.startsWith('v')) {
      log.error(`❌ Integrity Violation: Tag "${rawTag}" does not start with "v".`);
      log.info("HIPP requires release tags to follow the 'v1.2.3' convention.");
      process.exit(1);
    }

    const validVersion = semver.valid(rawTag);
    if (!validVersion) {
      log.error(`❌ Semver Violation: Tag "${rawTag}" is not a valid semantic version.`);
      process.exit(1);
    }

    return validVersion; 
  } catch (e) {
    log.error("❌ Integrity Error: No git tags found.");
    process.exit(1);
  }
}

async function askConfirmation(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

async function run() {
  const args = process.argv.slice(2);
  const separatorIndex = args.indexOf('--');
  
  const hippArgs = separatorIndex !== -1 ? args.slice(0, separatorIndex) : args;
  const npmArgs = separatorIndex !== -1 ? args.slice(separatorIndex + 1).join(' ') : '';
  const skipPrompt = hippArgs.includes('--yes') || hippArgs.includes('-y');
  
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) {
    log.error("❌ Error: No package.json found.");
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  if (pkg.version !== "0.0.0") {
    log.error(`❌ Integrity Violation: version is "${pkg.version}" (Must be 0.0.0)`);
    process.exit(1);
  }

  const status = execSync('git status --porcelain').toString();
  if (status) {
    log.error("❌ Integrity Error: Uncommitted changes found.");
    log.info("Clean your directory before publishing to ensure Git-Registry parity.");
    process.exit(1);
  }

  const gitVersion = getVersionFromGit();
  log.info(`🚀 \x1b[36mHIPP: High Integrity Package Publisher\x1b[0m`);
  log.success(`🏷️  Git Tag Truth: v${gitVersion}`);

  if (!skipPrompt) {
    const confirmed = await askConfirmation(`🚀 Confirm launch of \x1b[36m${pkg.name}@${gitVersion}\x1b[0m?`);
    if (!confirmed) {
      log.warn("❌ Launch aborted by user.");
      process.exit(0);
    }
  }

  let modified = false;
  try {
    pkg.version = gitVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    modified = true;
    
    log.info(`🔥 Ignition...`);
    execSync(`npm publish ${npmArgs}`, { stdio: 'inherit' });
    log.success(`\n✨ Success! Published ${pkg.name}@${gitVersion}`);
  } catch (err) {
    log.error(`\n💥 Launch failed.`);
  } finally {
    if (modified) {
      // Use Git to restore the file to its committed 0.0.0 state
      execSync('git checkout package.json', { stdio: 'ignore' });
      console.log(`🧹 Restored source integrity (git checkout package.json)`);
    }
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`\x1b[36mHIPP - High Integrity Package Publisher\x1b[0m\nBy Dmytri Kleiner <dev@dmytri.to>\n\nUsage: npx hipp [options] [-- npm-options]`);
} else {
  run();
}
