Status: in progress

# opencode setup on the T3 Code pod

Bring opencode with the full personal configuration from the `setup` repo
(skills, commands, agents, AGENTS.md, permissions, plugins) onto the always-on
T3 Code host (`apps/t3code.ts`), so opencode threads started there behave like
on the MacBook. Today the pod has no opencode at all, and the config only
exists as a Darwin-bound home-manager module.

## Context (from exploration, 2026-10-25)

- **Target pod** `apps/t3code.ts` (on `origin/main`, PR #269): namespace
  `t3code`, `devcontainers/base` image, user `vscode` (uid 1000), `$HOME` and
  `/nix` on local-path PVCs on maxdata. `bootstrap.sh` (ConfigMap) installs
  single-user Nix with flakes, `nix profile install`s node/gh/direnv/rg/jq,
  then claude, codex and `t3`, then `exec t3 serve`. Provider logins are done
  once by hand via `kubectl exec`. No opencode today.
- **Config source** `setup/modules/apps/opencode/default.nix` builds
  `~/.config/opencode` via home-manager; imported only by the two darwin hosts.
  No standalone `nix build` target, no Linux variant.
- Portable content: `global/{agents,commands,skills}`, `global/context.md`
  (→ AGENTS.md), `profiles/personal/*`, i-have-adhd pin, `context-percent.tsx`.
- Darwin/host-bound: brew opencode binary, Meridian proxy (launchd,
  127.0.0.1:3456), sops `auth.json` (age recipients: only the two Macs),
  `$HOME/projects/kopf3/*` profile switch, LSP store paths.
- Foreman workspace pods are **not** the target.

## Decisions

1. Target is the T3 Code pod (`apps/t3code.ts`), not the Foreman workspace pods.
2. Delivery: `setup` exposes a portable `packages.x86_64-linux.opencode-config`
   (same core as the darwin module, no home-manager in the pod);
   `bootstrap.sh` builds it and symlinks it to `~/.config/opencode`.
3. Updates are automatic, on the existing T3 fast lane: `apps/t3code.ts`
   pins the `setup` commit (and the opencode version); Renovate bumps both
   (`git-refs` on public `MaxMac99/setup` main, npm for opencode), automerges,
   `deploy.yml` runs `pulumi up` on push to main, the bootstrap hash changes
   and the pod rolls.
4. Restart cadence: the `setup` pin gets its own Renovate lane with
   `schedule: ["before 6am"]` and automerge, so `setup` changes restart the
   pod at most once a night. The opencode version stays on the fast T3 lane.
5. Providers: **Meridian** (Claude Max, same `anthropic.baseURL` + plugin as
   on the Mac) and **Codex** via opencode's native OpenAI provider, "Sign in
   with ChatGPT" (opencode v2 docs, providers page). No OpenRouter, no new
   Pulumi secret.
   - Meridian runs as a second container in the t3code pod (same image,
     same `$HOME` PVC, binary from the `setup` flake input), so it restarts
     independently of T3 and listens on `127.0.0.1:3456` inside the pod.
   - The ChatGPT login is a one-time `kubectl exec` step like `claude auth
     login`; the token lives in `~/.local/share/opencode/auth.json` on the
     PVC. The pod config must therefore never template `auth.json`.
6. opencode binary: pinned `OPENCODE_VERSION` in `apps/t3code.ts`, installed
   by `bootstrap.sh` from npm (like codex) and forced back to the pin on
   start, Renovate npm datasource on the t3code fast lane. Not from nixpkgs
   (still 1.x), not left to T3's self-updater (would drift from the pin).
7. Profile: the pod gets the **personal** profile only (global +
   `profiles/personal`); the Mac wrapper's `$HOME/projects/kopf3/*` switch
   does not exist there. Permissions are taken unchanged from the Mac — T3
   surfaces the `ask` prompts in its UI.
8. One core, two consumers: the darwin module is refactored to consume the
   same portable core, so Mac and pod cannot drift. The Mac's generated
   `~/.config/opencode` must be byte-identical before and after.

## Out of scope

- Skills/config for Foreman workspace pods.
- OpenRouter in the pod, and any sops recipient for the pod.
- The work (kopf3) profile in the pod.
- LSP servers in the pod (`lspPackages` on PATH); add later if needed.
- A prebuilt t3code image (already a follow-up of PR #269).

## Steps

Steps 1–2 are in the `setup` repo, 3–6 in this repo.

- [x] **1. Extract a portable opencode core in `setup`**
  - Goal: `modules/apps/opencode/core.nix` is a plain function
    (`{ lib, pkgs, inputs }` → `{ meridian, profiles, settings, commands,
    agents, skills, context, tui }`) holding everything portable;
    `default.nix` keeps only brew, wrapper, sops, launchd and consumes the
    core. The file tree itself is assembled in step 2.
  - Files: `setup/modules/apps/opencode/{core.nix,default.nix}`.
  - Done when: `darwin-rebuild build` for `Maxs-MacBook-Pro` succeeds and
    `diff -r` of the old and new `home-files/.config/opencode` (and the two
    `opencode-{work,personal}.json`) is empty.
- [ ] **2. Expose `opencode-config` and `meridian` as Linux packages in `setup`**
  - Goal: `packages.x86_64-linux.opencode-config` (`linkFarm`: `opencode.json`,
    `tui.json`, `AGENTS.md`, `agents/`, `commands/`, `skills/` incl. personal
    profile and i-have-adhd) and `packages.x86_64-linux.meridian` exist, and
    `check.yml` builds both.
  - Files: `setup/flake.nix`, `setup/.github/workflows/check.yml`.
  - Done when: the `setup` CI run on the PR builds both packages green, and
    `jq .provider.anthropic.options.baseURL result/opencode.json` prints
    `http://127.0.0.1:3456/v1`.
- [ ] **3. Install pinned opencode in the t3code pod**
  - Goal: `bootstrap.sh` installs `OPENCODE_VERSION` from npm and re-pins it
    on every start; Renovate tracks it on the t3code fast lane.
  - Files: `apps/t3code.ts`, `renovate.json`.
  - Done when: `pulumi preview` shows only the ConfigMap + Deployment
    annotation change; after deploy (**you**: merge),
    `kubectl -n t3code exec deploy/t3code -- bash -lc 'opencode --version'`
    prints the pin. Verify the npm package name before writing the regex.
- [ ] **4. Link the pinned `setup` config into the pod**
  - Goal: `SETUP_REV` (40-char sha) in `apps/t3code.ts`; `bootstrap.sh`
    runs `nix build github:MaxMac99/setup/$SETUP_REV#opencode-config
    --out-link ~/.local/state/opencode-config` and `ln -sfn`s it to
    `~/.config/opencode` (moving a pre-existing real directory aside once).
  - Files: `apps/t3code.ts`.
  - Done when: after deploy, `readlink ~/.config/opencode` points into
    `/nix/store`, and an opencode thread in T3 on the pod lists `/plan` and
    the `interview` skill. **You**: `opencode auth login` → OpenAI → Sign in
    with ChatGPT, then a Codex model answers.
- [ ] **5. Run Meridian as a sidecar**
  - Goal: a `meridian` container in the t3code pod (same image, `$HOME` PVC,
    `/nix` PVC) runs the `setup` meridian package for `SETUP_REV` and
    listens on `127.0.0.1:3456`; it waits until bootstrap has built the
    binary.
  - Files: `apps/t3code.ts`.
  - Done when: `kubectl -n t3code exec deploy/t3code -c t3code -- curl -sf
    127.0.0.1:3456/health` succeeds, and an opencode thread on an
    `anthropic/*` model answers via the pod's `claude` login.
- [ ] **6. Renovate lane for `SETUP_REV` and one-time setup docs**
  - Goal: a `git-refs` custom manager (`currentDigest` on
    `https://github.com/MaxMac99/setup`, `main`) bumps `SETUP_REV` in its own
    automerged group on the nightly schedule; the header of `apps/t3code.ts`
    lists the new one-time step (`opencode auth login`) and the update chain.
  - Files: `renovate.json`, `apps/t3code.ts`.
  - Done when: `bunx --package renovate renovate-config-validator` passes,
    and after merge the Renovate dependency dashboard lists
    `MaxMac99/setup`; the first nightly bump PR automerges and the pod rolls.

## Clarifications

### Session 2026-10-25

- Q: Which opencode on k3s — Foreman pods or a dedicated pod? → A: The T3 Code server pod.
- Q: Delivery via home-manager, Nix package, or git clone? → A: (implied by the update wish, recommendation B) Nix package from `setup`.
- Q: How do updates arrive? → A: Automatically, via Renovate in homelab-k8s and on `setup` changes, deployed without manual steps.
- Q: May every `setup` commit restart the pod? → A: No — nightly Renovate lane (`before 6am`) for the `setup` pin (B).
- Q: Which provider for opencode in the pod? → A: Meridian and Codex (ChatGPT subscription login).
- Step 1 (setup branch `opencode-core`): core interface takes `{ lib, pkgs, inputs }` and returns the parts, not a `profile`-specific tree — both profiles and the Meridian runtime (`host`, `port`, `pluginManifest`) are needed by the pod too. Verified stronger than planned: `system.build.toplevel.drvPath` of both darwin hosts unchanged (`2bxj6q0i…`, `mi21xy9k…`), so the whole system, not only `~/.config/opencode`, is identical.
- Not asked, recorded as assumptions (no effect on what gets built): opencode from npm pinned via Renovate; personal profile only; Mac permissions unchanged; darwin module refactored onto the shared core.
