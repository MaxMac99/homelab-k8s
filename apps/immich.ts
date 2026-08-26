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
import * as pulumi from "@pulumi/pulumi";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import { onNode, MAXDATA } from "../infrastructure/sites";
import { postgresWinkelHost, immichDatabase } from "../databases/postgresql";

const config = new pulumi.Config();

/**
 * Authentik OIDC credentials for the `immich` application.
 *
 * ⚠️ Created through Authentik's API, not declared here — this repo has no
 * Authentik blueprints, and Grafana and Paperless work the same way: the
 * provider lives in Authentik, only the resulting credentials live in the
 * stack's encrypted config. That means the provider itself is **not** captured
 * by this repo and would have to be rebuilt by hand after an Authentik rebuild.
 */
const oauthClientId = config.requireSecret("immich-oauth-client-id");
const oauthClientSecret = config.requireSecret("immich-oauth-client-secret");

const namespace = new k8s.core.v1.Namespace("immich", {
  metadata: { name: "immich" },
});

/** The hostname Immich answers on, inside the LAN only. */
const HOSTNAME = "photos.mvissing.de";

/**
 * The Immich release, pinned separately from the chart.
 *
 * ⚠️ **The chart does not track Immich releases, and the gap is real rather
 * than theoretical.** Chart 0.13.1 defaults to `v3.0.0` while Immich is on
 * `v3.1.0`; chart 0.12.0 defaulted to `v2.6.3`, a whole major version behind.
 * Taking the chart default means silently running whatever Immich version the
 * chart last happened to pin.
 *
 * ⚠️ Verified against the registry rather than assumed: `:release` and
 * `v3.1.0` resolve to the same digest, and `v3.1.1`/`v3.2.0` do not exist.
 * Renovate picks this up through the existing `image:`-style regex because of
 * the `repository`/`tag` pair below.
 */
const IMMICH_VERSION = "v3.1.0";

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
    version: "0.13.1",
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

        // ⚠️ `Secret`, not the chart's default `ConfigMap`. The OIDC client
        // secret below is part of this configuration, and the default would
        // render the whole thing — credential included — into a plain ConfigMap
        // readable by anything with ConfigMap access in this namespace.
        configurationKind: "Secret",

        // -------------------------------------------------------------------
        // Phase F — settled *before* a single file is imported.
        //
        // Changing either of these afterwards means a storage-migration job
        // over 2 TB of spinning disk, so they are deliberately not left to be
        // clicked into the admin UI once and forgotten.
        //
        // ⚠️ Supplying this sets `IMMICH_CONFIG_FILE`, which makes system
        // settings **read-only in the UI** — not just the two below, the whole
        // page. Tuning job concurrency during the import therefore means
        // editing this block and running `pulumi up`. Concurrency lives in the
        // same config file, so it stays possible; it is just slower than a
        // click. Chosen deliberately over the UI on 2026-08-26.
        //
        // ⚠️ Verified by rendering: this block is **not** passed through Helm's
        // `tpl`, so the Handlebars braces below survive intact. That is the
        // opposite of `alerting` in `monitoring/grafana.ts`, where the same
        // syntax had to be escaped. Do not "fix" these by escaping them.
        // -------------------------------------------------------------------
        configuration: {
          storageTemplate: {
            // Off by default, in which case Immich files everything under
            // random UUIDs.
            //
            // ⚠️ The reason this matters is not tidiness. Part of this library
            // is the only surviving copy of material lost from
            // `daten-familie`. With UUID filenames, losing Postgres would
            // leave 2 TB of unidentifiable files; with the template on, the
            // library stays salvageable without Immich at all.
            enabled: true,
            hashVerificationEnabled: true,

            // Requested layout: yyyy/album/MM-dd/model/filename, giving
            //   2015/Skiurlaub Gerlos/02-14/NIKON D300/DSC_4135.NEF
            //
            // ⚠️ **Triple braces throughout.** `{{album}}` HTML-escapes, which
            // mangles `DRK u. NetGo` and every umlaut in 4,619 event folders.
            //
            // ⚠️ The `{{#if}}` fallbacks are not optional. Scans, downloads and
            // WhatsApp images carry no `model`, and assets in no album have no
            // `album` — without the guards those become empty path segments.
            //
            // ⚠️ A multi-album asset resolves `{{album}}` to the most recently
            // created one, and resolving a duplicate merges the trashed
            // asset's albums into the keeper — so a deduped file can move
            // folder later. Not data loss, but the layout is not perfectly
            // stable. Filename collisions are safe: a sequence number is
            // appended, nothing is overwritten.
            template:
              "{{y}}/{{#if album}}{{{album}}}{{else}}Other{{/if}}/{{MM}}-{{dd}}/" +
              "{{#if model}}{{{model}}}{{else}}Unknown{{/if}}/{{{filename}}}",
          },

          ffmpeg: {
            // ⚠️ `disabled`, against a default of `required`.
            //
            // There is no GPU on any node, so every transcode is CPU-only on
            // maxdata. `Bilder` alone holds ~4.6k videos at 917 GiB, plus
            // 10.5k MOV in the backup tree; `required` would re-encode
            // everything not already h264/aac/mov and could run for weeks
            // while producing hundreds of GiB, competing with the very import
            // it is blocking.
            //
            // ⚠️ Videos in unsupported codecs will not play in the browser
            // until this changes. That is the accepted trade for Phases G–J:
            // get the files in and catalogued first. Phase K re-runs
            // `Transcode Video / All` once nothing competes with it — and that
            // is a `pulumi up` here, not a UI toggle.
            transcode: "disabled",
          },

          // -----------------------------------------------------------------
          // Phase E — OIDC via Authentik.
          //
          // ⚠️ **Provisioning is default-off, and the switch is the
          // `immich-users` group**, not anything in this file. The Authentik
          // application has a policy binding to that group, so a user who is
          // not a member cannot reach the app and is therefore never created in
          // Immich. Adding someone to the group provisions them on first login.
          //
          // ⚠️ `immich_role` is a *custom scope*, so it has to be requested
          // explicitly — the default scope list is `openid email profile` and
          // the claim would simply be absent, silently making everyone a
          // regular user. Verified: Authentik's discovery document for this
          // application lists `immich_role` in `scopes_supported`.
          //
          // ⚠️ Claims are applied **at user creation only and never
          // re-synced**. Getting Max's role wrong on first login means fixing
          // it in the Immich UI afterwards, not by editing this.
          // -----------------------------------------------------------------
          oauth: {
            enabled: true,
            issuerUrl: "https://auth.mvissing.de/application/o/immich/",
            clientId: oauthClientId,
            clientSecret: oauthClientSecret,
            scope: "openid email profile immich_role",
            roleClaim: "immich_role",
            storageLabelClaim: "preferred_username",
            buttonText: "Login with Authentik",
            autoRegister: true,
            // Deliberately false: the local login form stays reachable, which
            // is the escape hatch if OIDC breaks.
            autoLaunch: false,
          },

          // ⚠️ Local password login stays enabled until OIDC is verified end to
          // end. Disabling it before a successful Authentik login has been
          // observed would lock everyone out of a fresh instance with no admin
          // account — including the account that would fix it.
          passwordLogin: {
            enabled: true,
          },
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
