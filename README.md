# HIPP: High Integrity Package Publisher

By Dmytri Kleiner <dev@dmytri.to>

**HIPP** is a minimalist, stateless publishing tool that eliminates version-bump
commits and merge conflicts by treating Git Tags as the single source of truth.
Your `package.json` version stays permanently at `0.0.0`.

---

## The Problem

Traditional NPM versioning requires storing the "Version of Truth" in `package.json`.
This creates a **State Conflict**:

- `npm version` and `git tag` are two distinct, non-atomic actions
- If you tag a commit but forget to update the JSON (or vice-versa), your
  registry package and Git history diverge
- Every release requires a "chore: bump version" commit
- When multiple branches are developed simultaneously, these trivial changes
  cause constant merge conflicts

## The Solution

**HIPP makes `package.json` version immutable (0.0.0)** - the **HIPP Doctrine**.

Version is extracted directly from the Git Tag during publish. Your Git history
stays clean, and your registry package is guaranteed to match your Git tag.

---

## Usage

### Setup

1. Set your project's `package.json` version to `0.0.0`:

```json
{ "name": "your-package", "version": "0.0.0" }
```

2. Ensure `package-lock.json` exists and is tracked by git.

### Tag and Publish

```bash
git commit -m "Release"
git tag v1.0.0
git push origin main --tags
npx @dk/hipp
```

The tag and commit **must be pushed to origin** before running HIPP. HIPP verifies the
tag exists on the remote and that HEAD matches the upstream branch.

Use `-y` to skip confirmation (for CI):

```bash
npx @dk/hipp --yes
```

Pass npm options via `--`:

```bash
npx @dk/hipp -- --access public --tag beta
```

HIPP will:

1. **Key Generation**: Generate Ed25519 signing keys if needed (`hipp.priv`, `hipp.pub`)
2. **Verify**: Ensure the `0.0.0` doctrine is being followed
3. **Clean Check**: Ensure your git status is clean
4. **Validate**: Extract and verify the latest tag against Semver rules
5. **Sign**: Create a cryptographic manifest of your package content
6. **Publish**: Publish to npm from a staging directory (never mutating your source)
7. **Confirm**: Ask for confirmation before ignition (skip with `-y`)

### Signing Keys

On first run, HIPP generates an Ed25519 keypair:

- **`hipp.priv`** - Your private signing key. **Never committed to git.**
  Added to `.gitignore` automatically.
- **`hipp.pub`** - Your public verification key. **Committed to git** automatically.

The private key holder can sign packages. The public key verifies signatures.

**Key rotation**: Delete `hipp.pub` and run HIPP again. A new keypair will be
generated and committed automatically. Verification uses the public key from
the specific git revision at the tag, so previous packages remain verifiable
with their original keys.

**Multiple publishers**: Each developer can use their own private key. Delete
`hipp.pub`, run HIPP, and a new keypair will be generated for that revision.

### Why This Works

The public key in `hipp.pub` is committed to git at the specific revision of
each release. Verification always uses the key from that historical revision,
not a current one. This means:

- You don't need to retain your private key — once published, past releases are
  verifiable from the git history alone
- A compromised private key can only sign future releases, not forge past ones
- Multiple publishers work naturally because each release is self-contained

### Options

* `-y, --yes`: Skip the confirmation prompt (ideal for CI/CD pipelines).

To pass additional flags to npm publish (like access or a custom registry), use `--`:

```bash
npx @dk/hipp -- --access public --tag beta
```

---

## Verification

HIPP provides out-of-band verification to prove package integrity:

```bash
npx @dk/hipp verify                       # auto-detect: local hipp repo → published version, else @dk/hipp
npx @dk/hipp verify --self                # always verifies @dk/hipp itself
npx @dk/hipp verify @scope/package         # verifies latest of a package
npx @dk/hipp verify @scope/package@1.0.0   # verifies specific version
```

### How Verification Works

**Step 1: Get manifest from npm**

1. Fetch the package tarball from npm registry
2. Extract the README and parse the JSON manifest appended to it

The manifest contains:
```json
{
  "origin": "git@github.com:dk/your-package.git",
  "tag": "v1.0.0",
  "revision": "<git-commit-hash>",
  "hash": "<sha256-of-tarball>",
  "signature": "<base64-ed25519-signature>",
  "name": "Jane Developer",
  "email": "jane@example.com",
  "npm": "10.2.4",
  "node": "v20.11.0",
  "git": "2.34.1",
  "hipp": "0.1.22"
}
```

**Step 2: Clone git and verify**

3. Clone the repository at the tagged commit (using origin/tag from manifest)
4. Verify the cloned commit hash matches the `revision` field in manifest
5. Stage all tracked files
6. Run `npm pack` to create a tarball
7. Compute SHA256 hash of the clean tarball
8. Compare with the `hash` field from the npm manifest

**Step 3: Verify signature**

9. Read `hipp.pub` from the cloned repository
10. Verify the signature was created by signing:
    `hash + "\n" + origin + "\n" + tag + "\n" + revision + "\n" + name + "\n" + email`

**Step 4: Rebuild verification**

11. Append the manifest to the staged README
12. Update the staged `package.json` version to match the tag
13. Run `npm pack` again and verify the hash matches the npm tarball

### Three Verification Checks

| Check | What it proves |
|-------|----------------|
| **1. Signature** | The manifest was signed by the holder of the private key matching `hipp.pub` |
| **2. Manifest hash** | The claimed hash is accurate for this exact git revision |
| **3. Rebuild** | The npm tarball exactly matches what you'd produce from clean git source |

### What Verification Guarantees

- **Integrity**: The code in npm exactly matches git at the tagged commit
- **Authenticity**: The package was published by the holder of the private key
- **Reproducibility**: The npm tarball is byte-for-byte identical to a git rebuild

### What Verification Does NOT Guarantee

- **Code is safe or bug-free**: Malicious or buggy code can be signed
- **Publisher is trustworthy**: The key holder could sign bad code intentionally
- **Name/email is accurate**: These are read from local `git config` and could be set to anything

Verification proves that npm matches git - it says nothing about whether that
code is correct or safe.

---

## Dual-Channel Trust

npm and git serve as independent verification channels:

- **npm** records *when* and *what* was published by *whom*
- **git** records the source code and the public key

An attacker would need to compromise both registries to forge a valid package.
This doesn't prove code is safe, but it proves the code in npm matches git.

---

## Security

HIPP uses **Ed25519** public-key signatures. The private key never leaves your
machine. The public key is distributed via git. Anyone can verify a signed
package, but only private key holders can publish.

### Integrity Rules

HIPP enforces strict integrity rules when publishing:

- `package.json` version must be `0.0.0`
- `package-lock.json` must exist and be tracked by git
- `npm ci --ignore-scripts --dry-run` must succeed
- Repository must be clean
- HEAD must be on a branch with an upstream
- HEAD must exactly match upstream
- HEAD must have an exact v-prefixed semver tag
- The exact tag must exist on origin and match locally
- HEAD commit must be contained in an origin remote branch
- Only git-tracked files are staged
- Only staged `package.json` is rewritten

---

## License

**0BSD** (BSD Zero Clause License)  By Dmytri Kleiner <dev@dmytri.to>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
