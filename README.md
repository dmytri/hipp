# 🚀 HIPP: High Integrity Package Publisher

By Dmytri Kleiner <dev@dmytri.to>

**HIPP** is a minimalist, stateless publishing tool designed to eliminate the
friction of version-bump commits. It treats your **Git Tags** as the single
source of truth, enforcing a "Ground State" where your `package.json` version
remains permanently at `0.0.0`.

---

## 🧐 Why HIPP?

Traditional NPM versioning requires you to store your "Version of Truth" inside
your source code files (`package.json`). This creates a **State Conflict** that
leads to several systemic problems:

### 1. Integrity Failure in standard workflow
`npm version` and `git tag` are two distinct, non-atomic actions. If you tag a
commit but forget to update the JSON (or vice-versa), your registry package and
your Git history diverge. This scenario makes it impossible to guarantee that
the code in the registry matches the code at that tag. 

**HIPP ensures they are fundamentally linked by extracting the version directly
from the Git Tag.**

### 2. Chore" Noise & Merge Conflicts
Every release usually requires a "chore: bump version" commit. When multiple
branches are developed simultaneously, these version changes cause constant,
trivial merge conflicts. 

**HIPP makes your `package.json` version immutable (0.0.0), so it never
conflicts and your git history stays clean.**

---

## 🛠 Usage

### 1. The Setup Set your project's `package.json` version to `0.0.0`.
This is the **HIPP Doctrine**.

```json
{ "name": "your-package", "version": "0.0.0" }
```

### 2. Tag and Publish with HIPP

```bash
git tag v1.0.0
npx @dk/hipp
```

HIPP will:
1.  **Verify**: Ensure the `0.0.0` doctrine is being followed.
2.  **Clean Check**: Ensure your git status is clean (no uncommitted local
    "drift").
3.  **Validate**: Extract and verify the latest tag against Semver rules.
4.  **Confirm**: Ask for a 🚀 confirmation before ignition.
5.  **Restore**: Automatically return your local files to `0.0.0` after the
    smoke clears.

### Options
* `-y, --yes`: Skip the confirmation (ideal for CI/CD pipelines).

If you need to pass additional flags to npm publish (like access or a custom registry), use the -- separator:
Bash

`npx @dk/hipp -- --access public --tag beta`


---

## ⚖️ License

**0BSD** (BSD Zero Clause License)  By Dmytri Kleiner <dev@dmytri.to>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE. ```

