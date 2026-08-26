// Immich — self-hosted photo and video library.
//
// See docs/immich-migration.md Phase D. This file is the deployment only;
// importing ~2 TB of photos is Phases G–J and happens through the CLI on
// maxdata, not from here.
//
// ⚠️ Nothing public. This is on the internal Traefik, like every other app in
// this repo. `traefik-public` on ionos is default-closed and serves only ACME
// solvers.

import * as k8s from "@pulumi/kubernetes";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import { onNode, MAXDATA } from "../infrastructure/sites";
import { postgresWinkelHost, immichDatabase } from "../databases/postgresql";

const namespace = new k8s.core.v1.Namespace("immich", {
  metadata: { name: "immich" },
});

/** The hostname Immich answers on, inside the LAN only. */
const HOSTNAME = "photos.mvissing.de";

/**
 * The Immich release, pinned separately from the chart.
 *
 * ⚠️ **The chart does not track Immich releases.** Chart 0.12.0 happens to
 * default to v2.6.3 today, but the two version streams move independently, so
 * relying on the chart default means silently sitting on whatever Immich
 * version the chart last happened to pin. Renovate picks this up through the
 * existing `image:`-style regex because of the `repository`/`tag` pair below.
 */
const IMMICH_VERSION = "v2.6.3";

// ---------------------------------------------------------------------------
// Library storage — NFS on `tank`, the spinning pool.
//
// ⚠️ `storageClassName: "immich-library"` names no real StorageClass, and that
// is correct. `kubectl get sc` lists only `local-path`. For a *static* bind the
// class name is only a matching key between PV and PVC; `volumeName` below does
// the binding and no provisioner is involved. Paperless media does the same
// under `nfs`, Time Machine under `nfs-storage`. Do not "fix" this by adding an
// NFS provisioner.
//
// ⚠️ The chart cannot create this — "Automatically creating the library volume
// is not supported by this chart. You have to specify an existing PVC to use."
// Hence `existingClaim` below.
//
// ⚠️ This holds the only surviving copy of some of this material once
// `backup_old_drive` is deleted in Phase K. `Retain`, and nothing here should
// ever be pointed at a different path without moving the data first.
// ---------------------------------------------------------------------------
const libraryPV = new k8s.core.v1.PersistentVolume("immich-library-pv", {
  metadata: { name: "immich-library" },
  spec: {
    // Advisory only for a static NFS bind — `tank` had 7.18 TiB free on
    // 2026-08-26 and the deduped working set is projected at ~2.1 TiB plus
    // 10–20% for thumbnails and transcodes.
    capacity: { storage: "4Ti" },
    accessModes: ["ReadWriteMany"],
    persistentVolumeReclaimPolicy: "Retain",
    storageClassName: "immich-library",
    mountOptions: ["nfsvers=4.2", "hard", "intr"],
    nfs: {
      server: "192.168.178.2", // maxdata
      path: "/tank/k8s/nfs/immich",
    },
  },
});

const libraryPVC = new k8s.core.v1.PersistentVolumeClaim("immich-library-pvc", {
  metadata: { name: "immich-library", namespace: namespace.metadata.name },
  spec: {
    accessModes: ["ReadWriteMany"],
    storageClassName: "immich-library",
    volumeName: libraryPV.metadata.name,
    resources: { requests: { storage: "4Ti" } },
  },
});

/**
 * Machine-learning model cache.
 *
 * ⚠️ A real volume rather than the chart's default `emptyDir`, which is what
 * the chart itself recommends: "Set this to persistentVolumeClaim to avoid
 * downloading the ML models every start." With CPU-only inference over ~170k
 * assets, re-downloading CLIP and the face models on every restart is not a
 * minor cost.
 *
 * `local-path` on maxdata, so it is node-local — which is fine, because the ML
 * pod is pinned there anyway and the contents are a cache.
 */
const mlCachePVC = new k8s.core.v1.PersistentVolumeClaim(
  "immich-ml-cache-pvc",
  {
    metadata: { name: "immich-ml-cache", namespace: namespace.metadata.name },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: { requests: { storage: "15Gi" } },
    },
  },
);

/**
 * Valkey's job queue.
 *
 * ⚠️ Also a real volume rather than `emptyDir`, per the chart's own note: "Set
 * this to persistentVolumeClaim to keep job queues persistent." The full import
 * is a multi-day run; losing the queue to a pod restart part-way through means
 * re-discovering what still needs thumbnailing and embedding.
 */
const valkeyPVC = new k8s.core.v1.PersistentVolumeClaim("immich-valkey-pvc", {
  metadata: { name: "immich-valkey", namespace: namespace.metadata.name },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "local-path",
    resources: { requests: { storage: "8Gi" } },
  },
});

/**
 * Database connection, as individual variables rather than `DB_URL`.
 *
 * ⚠️ Deliberate, and the reason is the same one that nearly deleted Grafana:
 * **a secret value passed into a `helm.v3` chart cannot be rotated.** The chart
 * is rendered client-side at preview time, so an unknown value — which is what
 * a regenerated password is — makes the chart unrenderable and Pulumi plans to
 * delete every resource in it. `DB_URL` would have to embed the password
 * literally; these do not, because bjw-s's common library accepts a `valueFrom`
 * on any env entry.
 *
 * The Secret itself is created in `databases/postgresql.ts` and mirrored here
 * by Reflector.
 */
const DB_PASSWORD_SECRET = "postgres-immich";

/**
 * The image every `immich-server` container runs.
 *
 * ⚠️ Repeated per controller on purpose — see `sharedEnv`.
 */
const serverImage = {
  repository: "ghcr.io/immich-app/immich-server",
  tag: IMMICH_VERSION,
};

/**
 * Environment shared by both server controllers.
 *
 * ⚠️ **The chart's top-level `controllers.main` block does not reach a
 * controller with any other name.** Its values merge into each component's
 * `main` controller only, so `server.controllers.workers` inherits *nothing* —
 * not the image, not the database, not Redis. Rendering the chart without this
 * fails outright with `Container 'main': Image must be a dictionary with
 * repository and tag fields`, which is at least loud; the env would have been
 * silent, producing a worker pod that cannot reach Postgres.
 *
 * ⚠️ `REDIS_HOSTNAME` and `IMMICH_MACHINE_LEARNING_URL` are written as literals
 * here. The chart's own defaults for them are Helm template strings
 * (`{{ printf "%s-valkey" .Release.Name }}`), which resolve to exactly these
 * values given the pinned release name `immich` below — but only for the `main`
 * controller that receives them. Writing them out avoids both the gap and a
 * `tpl` evaluation this repo has been bitten by before.
 */
const sharedEnv = {
  DB_HOSTNAME: postgresWinkelHost,
  DB_PORT: "5432",
  DB_DATABASE_NAME: "immich",
  DB_USERNAME: "immich",
  DB_PASSWORD: {
    valueFrom: {
      secretKeyRef: { name: DB_PASSWORD_SECRET, key: "password" },
    },
  },
  // ⚠️ Set explicitly. The storage template renders dates in *server local
  // time*, so leaving this at UTC would file a photo taken at 00:30 CEST under
  // the previous day — for every photo, permanently.
  TZ: "Europe/Berlin",
  REDIS_HOSTNAME: "immich-valkey",
  IMMICH_MACHINE_LEARNING_URL: "http://immich-machine-learning:3003",
  // ⚠️ `DB_VECTOR_EXTENSION` is deliberately absent. Immich auto-detects and
  // prefers VectorChord when both are available, which is what
  // `postgres-winkel` has. The variable exists to *force* a choice, and setting
  // it to `pgvector` would silently opt out of the extension that cluster was
  // built for.
};

const immich = new k8s.helm.v3.Release(
  "immich",
  {
    chart: "oci://ghcr.io/immich-app/immich-charts/immich",
    version: "0.12.0",
    namespace: namespace.metadata.name,
    // ⚠️ Pinned rather than auto-named. The chart derives `immich-server`,
    // `immich-valkey` and `immich-machine-learning` from the release name, and
    // both the Ingress backend and `sharedEnv` above refer to those names.
    name: "immich",
    values: {
      // ⚠️ Pinned to maxdata, and this is not a preference.
      //
      // The first deploy of this file omitted it on the reasoning that the
      // volumes would force the placement anyway. That was wrong twice over,
      // and every pod landed on brink-server:
      //
      //   - the library is NFS *served by* maxdata, so all photo I/O crossed
      //     the WireGuard overlay at WAN latency — for a 2 TB import; and
      //   - `local-path`'s `nodePathMap` lists brink-server too, so the ML
      //     cache and the Valkey queue were provisioned *there*, and local-path
      //     stamps nodeAffinity onto a PV at first bind. Wrong node on the
      //     first schedule is permanent.
      //
      // ⚠️ A node pin, not `winkelSite`. Winkel's other node is winkel-pi,
      // which is arm64, and Immich publishes no arm64 machine-learning image.
      //
      // Top-level `defaultPodOptions` is sufficient — verified by rendering:
      // all four Deployments carry the selector. Unlike `controllers.main`
      // below, it does reach every component.
      defaultPodOptions: {
        nodeSelector: onNode(MAXDATA),
      },

      controllers: {
        main: {
          containers: {
            main: { image: serverImage, env: sharedEnv },
          },
        },
      },

      immich: {
        persistence: {
          library: { existingClaim: libraryPVC.metadata.name },
        },
      },

      valkey: {
        // ⚠️ Off by default in this chart. Immich does not start without it.
        enabled: true,
        persistence: {
          data: {
            enabled: true,
            type: "persistentVolumeClaim",
            existingClaim: valkeyPVC.metadata.name,
          },
        },
      },

      server: {
        enabled: true,
        controllers: {
          // The API — web UI and mobile app.
          //
          // ⚠️ `IMMICH_WORKERS_INCLUDE: api` is what makes the split real.
          // Without it this pod would also run every background job and the
          // separation would be cosmetic.
          main: {
            containers: {
              main: {
                env: { ...sharedEnv, IMMICH_WORKERS_INCLUDE: "api" },
              },
            },
          },
          // Background jobs: thumbnails, transcodes, ML queueing, metadata.
          //
          // ⚠️ A second controller, not a second release. Verified by rendering
          // the chart: this produces `immich-server-workers` beside
          // `immich-server-main`, and the `immich-server` Service selects on
          // `controller: main` **and** `name: server` — so API traffic never
          // reaches this pod. Had the selector been `name: server` alone, the
          // Service would have load-balanced HTTP onto a pod running no API
          // listener, failing intermittently.
          //
          // The point is Phase H: this can be scaled or restarted during the
          // import without taking the UI down.
          workers: {
            containers: {
              main: {
                image: serverImage,
                env: {
                  ...sharedEnv,
                  IMMICH_WORKERS_INCLUDE: "microservices",
                },
              },
            },
          },
        },
      },

      "machine-learning": {
        enabled: true,
        controllers: {
          main: {
            containers: {
              main: {
                image: {
                  repository: "ghcr.io/immich-app/immich-machine-learning",
                  tag: IMMICH_VERSION,
                },
              },
            },
          },
        },
        persistence: {
          cache: {
            enabled: true,
            type: "persistentVolumeClaim",
            existingClaim: mlCachePVC.metadata.name,
          },
        },
      },
    },
  },
  { dependsOn: [immichDatabase, libraryPVC, mlCachePVC, valkeyPVC] },
);

// ⚠️ Internal Traefik only. `ingressClassName: "traefik"` is the site-local
// controller; `traefik-public` would publish this to the internet, and this
// library is family photographs.
const immichIngress = new k8s.networking.v1.Ingress(
  "immich-ingress",
  {
    metadata: {
      name: "immich",
      namespace: namespace.metadata.name,
      annotations: {
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
        "cert-manager.io/cluster-issuer": activeClusterIssuer,
        "gethomepage.dev/enabled": "true",
        "gethomepage.dev/name": "Immich",
        "gethomepage.dev/description": "Photos",
        "gethomepage.dev/group": "Applications",
        "gethomepage.dev/icon": "immich",
        "gethomepage.dev/href": `https://${HOSTNAME}`,
      },
    },
    spec: {
      ingressClassName: "traefik",
      rules: [
        {
          host: HOSTNAME,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: "immich-server",
                    port: { number: 2283 },
                  },
                },
              },
            ],
          },
        },
      ],
      tls: [{ secretName: "immich-tls", hosts: [HOSTNAME] }],
    },
  },
  { dependsOn: [immich] },
);

export { namespace as immichNamespace, immich, immichIngress, libraryPVC };

// Remaining setup, which is Phases E–F and deliberately not automated here:
//
// 1. Phase E — Authentik OIDC provider, `immich-users` group + application
//    policy binding, and the `immich_role` property mapping. ⚠️ Claims are
//    applied at user creation only and never re-synced, so getting Max's role
//    wrong on first login means fixing it in the Immich UI afterwards. Keep
//    local password login enabled until OIDC is verified end to end.
//
// 2. Phase F — storage template and transcode policy, **before importing a
//    single file**. Changing either later means a storage-migration job over
//    2 TB of spinning disk.
//
//    ⚠️ The chart exposes `immich.configuration`, which is `immich-config.json`
//    as YAML, so both can be declared here rather than clicked through the UI.
//    That was not known when the plan was written and is worth taking: it makes
//    the storage template reviewable and reproducible. Note that setting it
//    makes the UI's config read-only.
//
//    The requested layout is `yyyy/album/MM-dd/model/filename`:
//
//      {{y}}/{{#if album}}{{{album}}}{{else}}Other{{/if}}/{{MM}}-{{dd}}/...
//
//    ⚠️ Triple braces throughout — `{{album}}` HTML-escapes, which mangles
//    `DRK u. NetGo` and every umlaut. The `{{#if}}` fallbacks are not optional
//    either: scans and WhatsApp images have no `model`, and without the guard
//    you get empty path segments.
//
//    ⚠️ Those braces would also be evaluated by Helm's `tpl` if passed through
//    chart values — the same trap that broke Grafana's alerting provisioning.
//    Escape them, or set the configuration via a separate ConfigMap and
//    `immich.existingConfiguration`.
