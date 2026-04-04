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

1. **Fetch from npm**: Downloads the package tarball and extracts the manifest
2. **Fetch from git**: Clones the repository at the tagged commit and extracts the public key
3. **Hash Verification**: Computes the hash of the git content and compares with the manifest
4. **Signature Verification**: Verifies the manifest signature using the public key

If both checks pass, you can be certain that:
- The package contents in npm exactly match the git tag
- The manifest was signed by the holder of the private key

### Integrity Rules

HIPP enforces strict integrity rules:

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


```json
{
  "origin": "git@github.com:dmytri/hipp.git",
  "tag": "v0.1.10"
}
```

```npx @dk/hipp @dk/hipp@0.1.10
```

<!-- HIPP-META -->
```json
{
  "origin": "git@github.com:dmytri/hipp.git",
  "tag": "v0.1.11"
}
```

```npx @dk/hipp @dk/hipp@0.1.11
```
<!-- /HIPP-META -->
