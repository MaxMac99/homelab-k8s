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
- `databases/` — shared database instances (PostgreSQL/CloudNativePG, Redis, MongoDB)
- `auth/` — identity and authentication (Authentik, Authentik Outpost)
- `apps/` — user-facing applications (Paperless, Homepage, UniFi, AdGuard, Home Assistant, Time Machine).
  ⚠️ **`apps/adguard.ts` is scheduled for deletion** — DNS now runs natively on
  brink-server and winkel-pi so it survives cluster rebuilds, and both routers
  already point at those. ⚠️ **`apps/timemachine.ts` sets no
  `metadata.namespace`** on its ConfigMap, PVC, Deployment or Service, so it all
  lands in `default`; it also hardcodes its own LB IP into `ADVERTISED_HOSTNAME`
  (`:116-118`), so the pin and the env var must change together.
- `monitoring/` — observability stack (Prometheus, Grafana, Loki, Tempo, Alloy, ntfy, unpoller)
- `index.ts` — orchestrator that imports all modules via directory barrel files
- `Pulumi.default.yaml` — stack config with encrypted secrets

**Key infrastructure layers:**

- **MetalLB** — ⚠️ still a **single** `default-pool` of `192.168.178.10-20`
  (`infrastructure/metallb.ts:45`), which only works for one site. Phase 8
  splits it into **two** pools with `L2Advertisement` node selectors:
  `192.168.1.240-250` (brink) and `192.168.178.240-250` (winkel). The pool also
  still declares an IPv6 range `fda8:a1db:5685::10-20` — **dead**: cluster
  dual-stack is dropped, and that ULA belonged to the old WireGuard tunnel.
- **Traefik** — Ingress controller with Authentik forward auth. Its LB IP
  `192.168.178.10` is **not pinned** (`infrastructure/traefik.ts:32` has the pin
  commented out); it holds that address by first-come luck from the pool.
- **cert-manager** — Let's Encrypt TLS. ⚠️ **The code is HTTP-01**
  (`infrastructure/cert-manager.ts:72-80`), not the DNS challenge this file used
  to claim. Phase 9 moves it to DNS-01 via the community
  `cert-manager-webhook-ionos`, which enables a wildcard.
- **Reflector** — mirrors Secrets/ConfigMaps across namespaces
- **CloudNativePG** — PostgreSQL operator (shared DB, per-app clusters)
- **Redis** — shared caching. ⚠️ **MongoDB is scheduled for deletion** in
  Phase 8: a 50 Gi PVC with **zero consumers** since UniFi moved to a bundled
  Mongo (`apps/unifi.ts:7`).

**Storage:** `local-path` for databases and NFS for bulk data, both served by
**`maxdata`** (`192.168.178.2`) — a bare-metal ZFS box, no longer Proxmox. Pools
are `tank` (spinning, RAIDZ1) and `fast` (NVMe).

⚠️ **`local-path` is node-local and there is no cross-site replication, by
design** (Longhorn/Ceph over consumer uplinks was rejected as a reliability
trap). Every `local-path` PVC therefore needs an explicit site pin, and a pod
that moves site loses its data. NFS is reachable cross-site over the overlay but
at WAN latency, so treat it as Winkel-local.

⚠️ **k3s runs with `--disable=local-storage`**, so nothing ships a
`local-path-provisioner` by default. Deploying it — with a per-node
`nodePathMap`, since the four nodes have genuinely different disks — is open
Phase 8 work. It used to be deployed by NixOS, pinned to a virtiofs path that no
longer exists.

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
