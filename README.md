# HIPP: High Integrity Package Publisher

By Dmytri Kleiner <dev@dmytri.to>

**HIPP** is a minimalist, stateless publishing tool designed to eliminate the
friction of version-bump commits. It treats your **Git Tags** as the single
source of truth, enforcing a "Ground State" where your `package.json` version
remains permanently at `0.0.0`.

HIPP provides **cryptographic signing** and **out-of-band verification** to
guarantee that the package in the npm registry exactly matches your git tag.

---

## Why HIPP?

### Integrity

Traditional NPM versioning requires you to store your "Version of Truth" inside
your source code files (`package.json`). This creates a **State Conflict** that
leads to several systemic problems:

`npm version` and `git tag` are two distinct, non-atomic actions. If you tag a
commit but forget to update the JSON (or vice-versa), your registry package and
your Git history diverge. This scenario makes it impossible to guarantee that
the code in the registry matches the code at that tag.

**HIPP ensures they are fundamentally linked by extracting the version directly
from the Git Tag, and cryptographically signing the package contents.**

### No "Chore" Noise

Every release usually requires a "chore: bump version" commit. When multiple
branches are developed simultaneously, these version changes cause constant,
trivial merge conflicts.

**HIPP makes your `package.json` version immutable (0.0.0), so it never
conflicts and your git history stays clean.**

---

## Usage

### Setup

1. Set your project's `package.json` version to `0.0.0`. This is the **HIPP Doctrine**.

```json
{ "name": "your-package", "version": "0.0.0" }
```

2. Ensure `package-lock.json` exists and is tracked by git.

### Tag and Publish

```bash
git tag v1.0.0
npx @dk/hipp
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

- **`hipp.priv`** - Your private signing key. **Never committed to git.** Added to `.gitignore` automatically.
- **`hipp.pub`** - Your public verification key. **Committed to git** automatically.

The private key holder can sign packages. The public key verifies signatures.

### Options

* `-y, --yes`: Skip the confirmation prompt (ideal for CI/CD pipelines).

To pass additional flags to npm publish (like access or a custom registry), use `--`:

```bash
npx @dk/hipp -- --access public --tag beta
```

---

## Verification

HIPP provides out-of-band verification to guarantee package integrity:

```bash
npx @dk/hipp verify @dk/your-package[@version]
```

### How Verification Works

**Step 1: Get manifest from npm**

1. Fetch the package tarball from npm registry
2. Extract the README from the tarball
3. Parse the JSON manifest appended to the README

The manifest contains:
```json
{
  "origin": "git@github.com:dk/your-package.git",
  "tag": "v1.0.0",
  "hash": "<sha256-of-tarball>",
  "signature": "<base64-ed25519-signature>"
}
```

**Step 2: Clone git and stage**

4. Clone the repository at the tagged commit (using origin/tag from manifest)
5. Copy all tracked files to a staging directory

**Step 3: Verify content integrity**

6. Run `npm pack` in the staging directory
7. Compute the SHA256 hash of the resulting tarball
8. Compare this hash with the `hash` field from the npm manifest

**If the hashes match**: The npm package exactly matches the git repository at the tagged commit.

**Step 4: Verify signature authenticity**

9. Read `hipp.pub` from the cloned repository at the tagged commit
10. Verify the signature using the public key

The signature was created by signing: `hash + "\n" + origin + "\n" + tag`

**If the signature is valid**: The package was published by the holder of the private key matching `hipp.pub`.

### What Verification Guarantees

| Check | Guarantees |
|-------|-----------|
| **Hash match** | npm package content exactly matches git at the tagged commit |
| **Signature valid** | Published by holder of the private key matching `hipp.pub` |

This provides two independent guarantees:
- **Integrity**: The code in npm is exactly what was in git at the tag
- **Authenticity**: The publisher controls the private key for `hipp.pub`

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

## Security

HIPP uses **Ed25519** public-key signatures. The private key never leaves your
machine. The public key is distributed via git. Anyone can verify a signed
package, but only private key holders can publish.

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