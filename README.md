# Kubernetes Resources via Pulumi

Pulumi (TypeScript) definitions for everything running on the k3s cluster:
databases, auth, ingress, monitoring, and user-facing apps. Each application
is a standalone `.ts` file; `index.ts` is the Pulumi entrypoint.

The cluster itself — k3s, the mesh overlay, sshd, sops, ZFS/NFS/Samba, and DNS
— is owned by the **`setup`** repo (NixOS, branch `multi-site`). The rule is:
_NixOS provides only what must exist before the cluster exists; everything
else is Pulumi._ See `docs/multi-site-migration.md` there for the full
migration history and decision log.

## Architecture

Four nodes across three L3 domains and two physical sites, joined by a
WireGuard mesh overlay (Headscale on ionos, Tailscale clients):

| Node           | Site (`topology.kubernetes.io/zone`) | Arch      | k3s role      | Notes                                               |
| -------------- | ------------------------------------ | --------- | ------------- | --------------------------------------------------- |
| `ionos`        | `public`                             | amd64     | server (etcd) | Public VPS. Tainted `edge=true:NoSchedule`          |
| `brink-server` | `brink`                              | amd64     | server (etcd) | Own apartment. Also the site's DNS + subnet router  |
| `maxdata`      | `winkel`                             | amd64     | server (etcd) | Parents' house. Bare-metal ZFS, NFS, Samba          |
| `winkel-pi`    | `winkel`                             | **arm64** | agent         | Raspberry Pi 4. Also the site's DNS + subnet router |

Both homes are behind CGNAT/DS-Lite, so the overlay is the only path between
sites. `local-path` storage is genuinely node-local — every stateful workload
pins to a node (`infrastructure/sites.ts`), not just a site. MetalLB runs two
address pools, one per site, in L2 mode with `autoAssign: false`.

`traefik-public` on ionos is **default-closed**: nothing is published to the
internet by accident, and which names get published at all is a deliberate,
ongoing decision rather than a config gap.

See `CLAUDE.md` for the detailed architecture notes, known traps, and coupling
points with the `setup` repo.

## File organization

- `infrastructure/` — core cluster services (MetalLB, Traefik ×2, cert-manager, CoreDNS, Reflector, local-path)
- `databases/` — shared PostgreSQL (CloudNativePG) and Redis
- `auth/` — Authentik and its outpost
- `apps/` — user-facing applications (Paperless, Homepage, UniFi, Home Assistant, Mosquitto, Music Assistant, Matter, Time Machine)
- `monitoring/` — Prometheus, Grafana, Loki, Tempo, Alloy, ntfy, unpoller, blackbox probes, dead-man's switch
- `index.ts` — orchestrator that imports every module via directory barrel files
- `Pulumi.default.yaml` — stack config, secrets encrypted under Pulumi Cloud's per-stack managed key

## Prerequisites

```bash
yarn install
pulumi login          # Pulumi Cloud; ~/.pulumi/credentials.json holds the session
```

## Deployment

```bash
# Preview infrastructure changes (dry run)
pulumi preview

# Deploy all resources
pulumi up

# Deploy while some apps are down for data restores
pulumi up --exclude '**timemachine**' --exclude '**unifi**' \
          --exclude '**paperless**' --exclude '**unpoller**' \
          --exclude '**tika**' --exclude '**gotenberg**'

# Tear down all resources
pulumi down

# Lint / format
npx eslint .
npx prettier --check .
```

There are no tests — validation happens via `pulumi preview` before deploying.

⚠️ **Never use `--target` on this stack — use `--exclude`.** With client-side
Helm chart rendering, targeting tears the provider connection down mid-render
and surfaces as `Duplicate resource URN` on an unrelated object. See
`CLAUDE.md` for the full explanation.

## Storage

`local-path` for databases and node-local app state; NFS (served by
`maxdata`) for bulk data like Paperless media and Time Machine. Neither is
cross-site replicated — see `CLAUDE.md` for why that's a deliberate choice,
not an oversight.
