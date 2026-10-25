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
- Dropping the hand-kept `anthropicModels` list in `setup/modules/apps/opencode/core.nix`.
  It only zeroes the displayed cost; every Anthropic model is available
  regardless. Follow-up in `setup` after this plan: spike (~30 min) whether
  an opencode v2 server plugin can zero the cost of all `anthropic/*` models
  at load time, then delete the list.

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
- [x] **2. Expose `opencode-config` and `meridian` as Linux packages in `setup`**
  - Goal: `packages.x86_64-linux.opencode-config` (`linkFarm`: `opencode.json`,
    `tui.json`, `AGENTS.md`, `agents/`, `commands/`, `skills/` incl. personal
    profile and i-have-adhd) and `packages.x86_64-linux.meridian` exist, and
    `check.yml` builds both.
  - Files: `setup/flake.nix`, `setup/.github/workflows/check.yml`.
  - Done when: the `setup` CI run on the PR builds both packages green, and
    `jq .provider.anthropic.options.baseURL result/opencode.json` prints
    `http://127.0.0.1:3456/v1`.
  - Verified: merged to `setup/main` as `7ed0d37`; CI run 40221700802,
    step "Build opencode packages for the T3 Code pod", green. Locally: darwin drvPaths unchanged, `nix flake check`
    green, and the same tree built for aarch64-darwin matches the Mac's live
    `~/.config/opencode` (opencode.json = live ⊕ personal profile, tui.json,
    AGENTS.md, agents, commands, skills all identical).
- [x] **3. Install pinned opencode in the t3code pod**
  - Goal: `bootstrap.sh` installs `OPENCODE_VERSION` from npm and re-pins it
    on every start; Renovate tracks it on the t3code fast lane.
  - Files: `apps/t3code.ts`, `renovate.json`.
  - Done when: `pulumi preview` shows only the ConfigMap + Deployment
    annotation change; after deploy (**you**: merge),
    `kubectl -n t3code exec deploy/t3code -- bash -lc 'opencode --version'`
    prints the pin. Verify the npm package name before writing the regex.
  - Verified locally: `pulumi preview -s default` → `2 changes. 438
unchanged` (t3code-bootstrap ConfigMap replace, t3code Deployment:
    bootstrap hash, `OPENCODE_VERSION` env, ConfigMap name); both version
    regexes match exactly once; renovate-config-validator and prettier green.
  - Verified on the cluster: merged as `582fd0a`, Pulumi Deploy run
    40229567623 green, pod rolled; `opencode --version` in the pod prints
    `opencode v2.1.4` from `/home/vscode/.npm-global/bin/opencode`.
- [ ] **4. Link the pinned `setup` config into the pod**
  - Goal: `SETUP_REV` (40-char sha) in `apps/t3code.ts`; `bootstrap.sh`
    runs `nix build github:MaxMac99/setup/$SETUP_REV#opencode-config
--out-link ~/.local/state/opencode-config` and `ln -sfn`s **each
    top-level entry** (`opencode.json`, `tui.json`, `AGENTS.md`, `agents`,
    `commands`, `skills`) into a real, writable `~/.config/opencode` —
    opencode writes `service.json`, `package.json` and `node_modules` there.
    The Mac wrapper's env (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY=x`,
    `OPENCODE_DISABLE_LSP_DOWNLOAD=1`) goes into a `~/.local/bin/opencode`
    wrapper, not the container env.
  - Files: `apps/t3code.ts`.
  - Done when: after deploy, `readlink ~/.config/opencode/opencode.json`
    points into `/nix/store`, and an opencode thread in T3 on the pod lists `/plan` and
    the `interview` skill. **You**: `opencode auth login` → OpenAI → Sign in
    with ChatGPT, then a Codex model answers.
- [ ] **5. Run Meridian as a sidecar**
  - Goal: a `meridian` container in the t3code pod (same image, `$HOME` PVC,
    `/nix` PVC) runs the `setup` meridian package for `SETUP_REV` — a
    wrapper that already sets `MERIDIAN_HOST/PORT/PLUGIN_CONFIG` — and
    listens on `127.0.0.1:3456`; it waits until bootstrap has built it.
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
- Q: Why are the Claude models listed by hand in `core.nix`? → A: The list only zeroes the displayed cost, availability is unaffected; no global cost switch or model wildcard in the v2 config docs. Keep the list for now, follow-up spike for a cost-zeroing plugin (out of scope).
- Step 2 (setup `c95ab68`): the personal profile is merged into the tree's `opencode.json` instead of riding in `OPENCODE_CONFIG`, so the pod needs no profile env. `packages.meridian` is a wrapper with Meridian's env baked in (step 5 just runs it). Correction to step 4: the Mac's `~/.config/opencode` is a real directory with per-entry symlinks and runtime files written by opencode, so the pod links entries one by one instead of symlinking the directory; step 4 also takes over the Mac wrapper's env (`ANTHROPIC_API_KEY=x`, `OPENCODE_DISABLE_LSP_DOWNLOAD=1`).
- Step 3: npm `opencode-ai` is still opencode 1 (`latest` 1.19.4); opencode 2 ships as `@opencode/cli` (opencode.ai/v2/docs, install section), currently 2.1.4 = the Mac's brew version. Decision 6 now means that package. It joins the `t3code` Renovate group (one fast-lane PR with `t3`).
- Step 4: correction — `ANTHROPIC_API_KEY=x` on the container would also hit the `claude` CLI in the pod and replace the Max login with the dummy key (the Mac scopes it to its wrapper for the same reason). The env therefore lives in a `~/.local/bin/opencode` wrapper written by `bootstrap.sh`. Pinned `SETUP_REV` = `a2e5d01` (contains the step 2 merge, CI green); a manual build in the pod took 79 s. A failed `nix build` keeps the previous link instead of crash-looping T3.
- Not asked, recorded as assumptions (no effect on what gets built): opencode from npm pinned via Renovate; personal profile only; Mac permissions unchanged; darwin module refactored onto the shared core.
