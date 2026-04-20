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

**Cluster topology:** K3S with 1 Raspberry Pi (ARM64, runs AdGuard on hostPort) + 3 Proxmox x86_64 VMs. Use `nodeSelector` when workloads must target a specific architecture.

**File organization:**
- `infrastructure/` — core cluster services (MetalLB, Traefik, cert-manager, Reflector)
- `databases/` — shared database instances (PostgreSQL/CloudNativePG, Redis, MongoDB)
- `auth/` — identity and authentication (Authentik, Authentik Outpost)
- `apps/` — user-facing applications (Paperless, Homepage, UniFi, AdGuard, Home Assistant, Time Machine)
- `monitoring/` — observability stack (Prometheus, Grafana, Loki, Tempo, Alloy, ntfy, unpoller)
- `index.ts` — orchestrator that imports all modules via directory barrel files
- `Pulumi.default.yaml` — stack config with encrypted secrets

**Key infrastructure layers:**
- **MetalLB** — LoadBalancer IPs (192.168.178.10-20)
- **Traefik** — Ingress controller with Authentik forward auth
- **cert-manager** — Let's Encrypt TLS via DNS challenge
- **Reflector** — mirrors Secrets/ConfigMaps across namespaces
- **CloudNativePG** — PostgreSQL operator (shared DB, per-app clusters)
- **Redis/MongoDB** — shared caching and document storage

**Storage:** `local-path` (ZFS-backed SSDs) for databases; NFS (Proxmox tank pool at 192.168.178.2) for bulk data.

## Code Patterns

- **Imports:** `import * as k8s from "@pulumi/kubernetes"` / `@pulumi/pulumi` / `@pulumi/random`
- **Secrets:** stored encrypted in `Pulumi.default.yaml`, accessed via `config.requireSecret()` or `config.getSecret()`, created as Kubernetes Secrets with `stringData`
- **Dependencies:** explicit `dependsOn` arrays for resource ordering; files export key resources for cross-file references
- **Namespaces:** one per application, each file creates its own namespace
- **Helm charts:** deployed via `k8s.helm.v3.Release` or `k8s.helm.v3.Chart` with inline values
- **Ingress:** Traefik `IngressRoute` CRDs for advanced routing; standard `Ingress` for simpler cases

## Renovate

Dependency updates are automated via Renovate (`renovate.json`) with custom regex managers that detect Docker image versions and Helm chart versions directly from `.ts` files. When changing image or chart versions, maintain the format that Renovate's regex patterns expect (e.g., `image: "repo:tag"` on one line, or `repository`/`tag` on adjacent lines).