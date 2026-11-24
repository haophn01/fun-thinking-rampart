# corepack enable fails with EPERM on this machine

_Found: 2026-11-23 · by: B1 (foundation) · plan: cmmc-l2-grc_

**What happens:** `corepack enable` exits with `EPERM`. The Node install under nvm4w (`C:\Users\howar\AppData\Local\nvm\v24.15.0`) can't be written by a normal shell, so corepack can't drop its `pnpm` shim there. It still fails with the sandbox turned off.

**Workaround** (any one):
- `corepack enable --install-directory <a user-writable folder> pnpm`, then put that folder first on PATH. The orchestrator's shims are in its session scratchpad under `bin/`.
- Prefix commands with `corepack pnpm …`.
- Run `corepack enable` once from an elevated shell.

**Who it affects:** every engineer and reviewer running the smoke recipe here. pnpm is pinned at 10.34.9 in `package.json` `packageManager`. If the shim falls back to another pnpm version, it tries to rebuild `node_modules`.

**Fix someday:** when this machine's Node install is user-writable, plain `corepack enable` works and this file can be closed.
