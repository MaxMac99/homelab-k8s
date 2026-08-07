# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pulumi TypeScript project that manages all Kubernetes resources on a K3S homelab cluster. Each application is a standalone `.ts` file; `index.ts` imports them all as the Pulumi entrypoint.

## Commands

```bash
# Install dependencies
yarn install

# Preview infrastructure changes (dry run)
pulumi preview

# Deploy all resources
pulumi up

# Tear down all resources
pulumi down

# Lint
npx eslint .

# Format
npx prettier --check .
```

There are no tests — validation happens via `pulumi preview` before deploying.

## Architecture

> ⚠️ **This cluster was rebuilt from scratch on 2026-08-07.** It is now a
> four-node cluster spanning **three L3 domains and two physical sites**, not a
> single-site one. The three Proxmox x86_64 VMs described here previously
> (`k3s-node1/2/3`) **no longer exist** — they were microVMs on `maxdata` and
> were destroyed. See `docs/multi-site-migration.md` in the **`setup`** repo
> (branch `multi-site`) for the full plan; Phases 0–7 are done and **Phase 8
> (storage and site affinity) is the current work, and it is mostly this repo**.

**Cluster topology**

| Node           | Site (`topology.kubernetes.io/zone`) | Arch      | k3s role      | Notes                                                                                    |
| -------------- | ------------------------------------ | --------- | ------------- | ---------------------------------------------------------------------------------------- |
| `ionos`        | `public`                             | amd64     | server (etcd) | Public VPS. **Tainted `edge=true:NoSchedule`** — nothing lands here without a toleration |
| `brink-server` | `brink`                              | amd64     | server (etcd) | Own apartment. Also the site's DNS + subnet router                                       |
| `maxdata`      | `winkel`                             | amd64     | server (etcd) | Parents' house. ZFS, NFS, Samba — **bare metal now, not Proxmox**                        |
| `winkel-pi`    | `winkel`                             | **arm64** | agent         | Raspberry Pi 4. Also the site's DNS + subnet router                                      |

**Two things follow from this and drive most of Phase 8:**

1. **Every node is addressed on a WireGuard mesh overlay**, not on a LAN.
   `INTERNAL-IP` is `100.64.0.1` (ionos), `.2` (brink-server), `.3` (winkel-pi),
   `.5` (maxdata). Both homes are behind **CGNAT/DS-Lite**, so the overlay is
   the _only_ path between sites. Pod MTU is **1230** — flannel derives it from
   the overlay's 1280.
2. **The two sites are different L2 segments.** MetalLB L2 mode needs a shared
   segment, so one pool can no longer serve both. `local-path` volumes are
   genuinely node-local — the old assumption that `/mnt/k8s-fast` was shared via
   virtiofs (`databases/postgresql.ts:291`) is **false now that maxdata is a
   real node**.

Use `nodeSelector` for architecture (`winkel-pi` is the only arm64 node) and
`topology.kubernetes.io/zone` for site placement.

**File organization:**

- `infrastructure/` — core cluster services (MetalLB, Traefik, cert-manager, Reflector)
- `databases/` — shared database instances (PostgreSQL/CloudNativePG, Redis).
  MongoDB was **deleted** in Phase 8 — 50 Gi, zero consumers.
- `auth/` — identity and authentication (Authentik, Authentik Outpost)
- `apps/` — user-facing applications (Paperless, Homepage, UniFi, Home
  Assistant, Mosquitto, Time Machine). `apps/adguard.ts` was **deleted** in
  Phase 8 — DNS runs natively on brink-server and winkel-pi so it survives
  cluster rebuilds. Time Machine now has its **own namespace** rather than
  landing in `default`. ⚠️ It still hardcodes its LB IP into
  `ADVERTISED_HOSTNAME`, so that env var and the MetalLB pin must change
  together — both now read from `infrastructure/sites.ts`.
- `monitoring/` — observability stack (Prometheus, Grafana, Loki, Tempo, Alloy, ntfy, unpoller)
- `index.ts` — orchestrator that imports all modules via directory barrel files
- `Pulumi.default.yaml` — stack config with encrypted secrets

**Key infrastructure layers:**

- **MetalLB** — **two** pools, split per site in Phase 8 and deployed:
  `brink-pool` `192.168.1.240-250` and `winkel-pool` `192.168.178.240-250`, each
  with an `L2Advertisement` selecting `topology.kubernetes.io/zone`. The dead
  `fda8:a1db:5685::` range is gone. ⚠️ **`autoAssign` is `false` on both.** A
  LoadBalancer with no explicit address gets none and stays visibly Pending —
  deliberate, so nothing can silently repeat Traefik's old habit of winning
  `192.168.178.10` by allocation order. All pins live in
  `infrastructure/sites.ts`; put new ones there, not inline.
- **Traefik** — Ingress controller with Authentik forward auth, pinned to
  `sites.winkel.ingressVIP` (`192.168.178.240`) and to the Winkel site. ⚠️
  **Brink's `192.168.1.240` serves nothing yet** — Phase 9 adds the per-site
  internal Traefik. Both sites' AdGuard already rewrite `*.mvissing.de` to their
  own VIP, so Brink resolves every hostname to a dead address today. ⚠️
  Anything belonging in the Service spec must go under **`service.spec`**; the
  chart renders only that key and silently drops `type`/`ipFamilyPolicy` placed
  directly under `service`. Logging keys are `log` and `accessLog`, not `logs`.
- **cert-manager** — Let's Encrypt TLS, **HTTP-01 and staying that way**
  (`infrastructure/cert-manager.ts:72-80`). ⚠️ **D8 was revised on 2026-08-07:
  DNS-01 via `cert-manager-webhook-ionos` is dropped and there will be no IONOS
  DNS API token.** D7 removes the need — once Phase 9 puts Traefik on ionos,
  port 80 reaches it and HTTP-01 validates for every name. No wildcard;
  per-hostname certs, which ~10 names keeps well inside Let's Encrypt's limits.
- **local-path-provisioner** — deployed from Pulumi (`infrastructure/local-path.ts`),
  **not** from NixOS, with a per-node `nodePathMap`: `/fast/k8s/local-path` on
  maxdata, `/var/lib/k8s/local-path` on brink-server. ⚠️ ionos and winkel-pi are
  deliberately absent so provisioning there fails loudly. `WaitForFirstConsumer`
  and `Retain`; the ConfigMap is **auto-named on purpose** — a fixed name makes
  pulumi-kubernetes' replace-on-data-change collide with the live object.
- **Reflector** — mirrors Secrets/ConfigMaps across namespaces
- **CloudNativePG** — PostgreSQL operator (shared DB, per-app clusters)
- **Redis** — **two instances.** The shared one in `databases/redis.ts` is
  pinned to maxdata and now serves only Paperless; Authentik has its own in
  `auth/authentik.ts`, at Brink. ⚠️ That split is load-bearing, not tidiness:
  Authentik gates forward auth for every ingress at both sites, so it must not
  depend on maxdata. Postgres runs `instances: 2` with zone anti-affinity for
  the same reason.

**Storage:** `local-path` for databases and NFS for bulk data, both served by
**`maxdata`** (`192.168.178.2`) — a bare-metal ZFS box, no longer Proxmox. Pools
are `tank` (spinning, RAIDZ1) and `fast` (NVMe).

⚠️ **`local-path` is node-local and there is no cross-site replication, by
design** (Longhorn/Ceph over consumer uplinks was rejected as a reliability
trap). Every `local-path` PVC therefore needs an explicit site pin, and a pod
that moves site loses its data. NFS is reachable cross-site over the overlay but
at WAN latency, so treat it as Winkel-local.

⚠️ **k3s runs with `--disable=local-storage`**, so no provisioner ships by
default — Pulumi supplies it (above). Note the pins are to a **node**, not a
site: Winkel has two nodes and winkel-pi's USB-SATA disk is not where anything
belongs. local-path stamps `nodeAffinity` onto the PV it creates, so a _bound_
volume already cannot move; what the pin controls is which node gets it on
**first** binding, which is permanent.

⚠️ **Both node paths sit under a parent that exists whether or not the dataset
mounts** — `/fast/k8s` on maxdata, `/var/lib/k8s` (on `main/root`) on
brink-server. If a dataset fails to mount, volumes are written to the parent
filesystem and nothing complains; this is exactly how maxdata's 689 G of Time
Machine data ended up shadowing an empty `tank/k8s/timemachine`. Monitor for
_not mounted_, not for disk usage.

## The other repo, and what couples to it

The **`setup`** repo (NixOS, branch `multi-site`) owns everything that must
exist _before_ this cluster can: the overlay, k3s itself, sshd, sops, the ZFS
pools and NFS/Samba on maxdata, and **AdGuard running natively** at both sites.
The rule is: _NixOS provides only what must exist before the cluster exists;
everything else is Pulumi._

Three couplings can break silently, because nothing in this repo references
them:

1. **Alloy → Loki.** `hosts/nixos/maxdata/monitoring.nix` ships maxdata's logs
   to a hardcoded in-cluster Loki LoadBalancer (`192.168.178.11`). Repinning
   Loki without changing that value **stops log shipping with no error**.
2. **ionos's DNAT rules** hardcode Traefik's `192.168.178.10` in six iptables
   rules. Phase 9 (D7) replaces the DNAT path with hostNetwork Traefik, which is
   also what restores real client IPs in logs — today every public client
   appears as the tunnel address.
3. **Node zone labels** are set by NixOS via k3s flags, not by Pulumi. Note the
   label changed from `external` to `public` for ionos when the cluster was
   rebuilt, so any `nodeSelector` using the old value matches nothing.

## Code Patterns

- **Imports:** `import * as k8s from "@pulumi/kubernetes"` / `@pulumi/pulumi` / `@pulumi/random`
- **Secrets:** stored encrypted in `Pulumi.default.yaml`, accessed via `config.requireSecret()` or `config.getSecret()`, created as Kubernetes Secrets with `stringData`
- **Dependencies:** explicit `dependsOn` arrays for resource ordering; files export key resources for cross-file references
- **Namespaces:** one per application, each file creates its own namespace
- **Helm charts:** deployed via `k8s.helm.v3.Release` or `k8s.helm.v3.Chart` with inline values
- **Ingress:** Traefik `IngressRoute` CRDs for advanced routing; standard `Ingress` for simpler cases

## Renovate

Dependency updates are automated via Renovate (`renovate.json`) with custom regex managers that detect Docker image versions and Helm chart versions directly from `.ts` files. When changing image or chart versions, maintain the format that Renovate's regex patterns expect (e.g., `image: "repo:tag"` on one line, or `repository`/`tag` on adjacent lines).
