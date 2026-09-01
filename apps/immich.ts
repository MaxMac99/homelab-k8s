// Immich — self-hosted photo and video library.
//
// See docs/immich-migration.md Phase D. This file is the deployment only;
// importing ~2 TB of photos is Phases G–J and happens through the CLI on
// maxdata, not from here.
//
// ⚠️ **This one *is* public**, unlike most of this repo. There are two
// Ingresses below: the internal one on the site-local Traefik, and a second on
// `traefik-public` at ionos. See the note on `immichPublicIngress` for what
// that does and does not protect.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import { onNode, MAXDATA, publicIngressClass } from "../infrastructure/sites";
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

/**
 * The hostname Immich answers on — on the LAN *and* from the internet.
 *
 * ⚠️ Split-horizon DNS makes one name mean two paths. Inside either home the
 * site AdGuard rewrites this to that site's `ingressVIP`, so LAN clients reach
 * the internal Traefik directly. Everywhere else it resolves to ionos
 * (`photos` is a CNAME to `mvissing.de` → 212.132.82.102) and arrives through
 * `traefik-public`. Both paths terminate the same `immich-tls` certificate.
 */
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
  // ⚠️ **The chart sets this only on the `main` controller**, and without it a
  // container mounts `/config` but never reads it — falling back silently to
  // the database defaults.
  //
  // That is not cosmetic. The workers pod is what runs the background jobs, so
  // *it* is the one that decides:
  //
  //   - whether to apply the storage template. `handleMigrationSingle` opens
  //     with `if (!config.storageTemplate.enabled) return JobStatus.Skipped` —
  //     no log, no error, no failed job. All 1,574 pilot assets stayed in
  //     `upload/` under UUID names while the API pod cheerfully reported
  //     `storageTemplate.enabled: true`, because the API pod *did* have the
  //     file.
  //   - whether to transcode. The default is `required`, not the `disabled`
  //     set in the configuration below, so the workers re-encoded video we had
  //     explicitly told Immich to leave alone.
  //
  // ⚠️ The path must match the chart's own mount (`/config`, filename from
  // `configurationKind`). It is repeated here rather than derived because the
  // chart offers no value to read it back from.
  IMMICH_CONFIG_FILE: "/config/immich-config.yaml",
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
            // ⚠️ **A multi-album asset resolves `{{album}}` to the most
            // recently *created* album, and that is a standing hazard rather
            // than a curiosity.** Read from source on 2026-08-27:
            // `AlbumRepository.getByAssetId` (album.repository.js:75-89) joins
            // `album_user` for the asset's owner and closes with
            // `.orderBy('album.createdAt', 'desc')`; the storage template then
            // takes `albums?.[0]` (storage-template.service.js:245).
            //
            // A newly created album is by definition the newest, so **adding a
            // pre-existing asset to a new album re-files that asset on disk** —
            // `2015/Skiurlaub Gerlos/02-14/NIKON D300/DSC_4135.NEF` becomes
            // `2015/<new album>/02-14/NIKON D300/DSC_4135.NEF`. Do that to a
            // shared "family" album and the on-disk event structure, which is
            // the entire reason this template exists, collapses into one folder.
            //
            // ⚠️ **It is latent, not immediate, which is what makes it
            // dangerous.** The only automatic trigger is
            // `onAssetMetadataExtracted` (storage-template.service.js:105), so
            // the move does not happen when the album is edited — it happens
            // the next time anyone runs **Storage Migration / All**. Phase K
            // plans a bulk job re-run. Check this note before queueing one.
            //
            // ⚠️ **Sharing an existing album is safe and is not the same
            // operation.** It adds an `album_user` row; it does not change
            // which albums an asset belongs to, so `{{album}}` is untouched and
            // nothing moves. The query filters on `album_user.userId = <asset
            // owner>`, so adding *other* users to your albums cannot perturb
            // your own assets' paths either. Share albums freely; do not move
            // old assets into new albums.
            //
            // Resolving a duplicate merges the trashed asset's albums into the
            // keeper, so a deduped file can move folder by the same mechanism.
            // Filename collisions are safe: a sequence number is appended,
            // nothing is overwritten.
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

          image: {
            // ⚠️ Off by default, and the symptom is misleading: RAW files show
            // a correct grid thumbnail and then a *blank* detail view.
            //
            // The viewer needs something a browser can decode. For a JPEG that
            // is the original; for a NEF it is not, and without a full-size
            // derivative there is no fallback — `asset_file` held only
            // `preview`/`thumbnail` rows, so the preview was healthy while the
            // asset appeared broken. 16,287 NEFs in the library, so this is not
            // a corner case.
            //
            // Cost is roughly 35–50 GiB of derived JPEG and extra work in
            // `thumbnailGeneration` per RAW asset. Enabled mid-import
            // deliberately: assets still to come get it inline, which is
            // cheaper than a full `Generate Thumbnails / All` afterwards.
            fullsize: {
              enabled: true,
              format: "jpeg",
              quality: 80,
            },
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
            // Skip Immich's own login page and go straight to Authentik.
            //
            // ⚠️ `/auth/login?autoLaunch=0` still reaches the login screen —
            // but with `passwordLogin` off below, that screen has nothing to
            // offer. It is a way past the redirect, not a way in.
            autoLaunch: true,
          },

          // Authentik is the only way in.
          //
          // ⚠️ **Enabled only after an OIDC login was observed working**, not
          // before. The admin account was originally created through this form
          // (`oauthId` empty) and has since been linked to Authentik by
          // matching email — Authentik's `Max` carries the same address, so the
          // login attached to the existing admin rather than creating a second
          // user. Turning this off before that link existed would have locked
          // the only administrator out of the instance.
          //
          // ⚠️ **Recovery is a `pulumi up`, not a support ticket.** Because this
          // configuration is file-managed, flipping this back to `true` and
          // re-applying restores password login without needing to log in
          // first. That is the whole escape hatch — there is no in-band one.
          //
          // ⚠️ **This couples Immich's availability to Brink.** All three
          // Authentik pods pin to `onNode(BRINK_SERVER)` while Immich runs at
          // Winkel, so a Brink outage now means nobody can log in to Immich
          // even though Immich itself is up and serving. That was already true
          // for every forward-auth ingress; it is newly true for Immich.
          passwordLogin: {
            enabled: false,
          },

          // -------------------------------------------------------------------
          // ⚠️ **DEFERRED — uncomment once the Phase H import has drained.**
          //
          // Not because the setting is risky, but because *any* edit inside
          // `immich.configuration` is. The chart renders this block into the
          // `immich-immich-config` Secret and stamps its digest onto both
          // server pods as `checksum/config`, so changing one character here
          // rolls `immich-server-main` **and** `immich-server-workers`.
          //
          // The Valkey queue is persistent (see `valkeyPVC`), so the job queue
          // survives that. An in-flight `immich-cli` upload does not: it loses
          // the connection when the old API pod terminates, and the CLI reports
          // it as `ReadableStream is already closed` — a client-side undici
          // error naming neither the pod nor the restart. That is the same
          // misleading symptom the OOM episode produced.
          //
          // Publishing does **not** depend on this. The public Ingress below
          // works without it; all this changes is the absolute URLs Immich
          // hands *out*.
          //
          // Check before uncommenting:
          //   kubectl exec -n database postgres-winkel-1 -c postgres -- \
          //     psql -U postgres -d immich -t -c \
          //     "select count(*) from asset where \"createdAt\" > now() - interval '15 min'"
          // -------------------------------------------------------------------
          // server: {
          //   // ⚠️ Not cosmetic now that this is published. Immich builds the
          //   // absolute URLs it hands *out* from this value — public share
          //   // links, the OAuth redirect it computes for the mobile app, and
          //   // the links in notification emails. Left empty, it falls back to
          //   // the `Host` of whichever request happened to create the link, so
          //   // a share link minted from the LAN would carry the internal URL
          //   // and be dead for the person it was sent to.
          //   externalDomain: `https://${HOSTNAME}`,
          //
          //   // ⚠️ Immich's default `true`, restated deliberately. It lets a
          //   // logged-in user see the other accounts on the instance, which is
          //   // what makes "share this album with…" an autocomplete rather than
          //   // a game of typing an exact email address. Album sharing here is
          //   // entirely manual (there are no groups in Immich — no `group`
          //   // table, no `group` controller, `album_user` is the only sharing
          //   // relation), so that autocomplete is the whole ergonomics of it.
          //   publicUsers: true,
          // },
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

      /**
       * Memory bounds for the Immich containers.
       *
       * ⚠️ **These were absent, and maxdata paid for it.** Phase D shipped with no
       * `resources` at all, so nothing bounded Immich's upload buffering. During the
       * Phase H import the kernel OOM-killer took the server twice —
       * `SystemOOM, victim process: immich-api` — and the CLI's only symptom was
       * `ReadableStream is already closed`, a client-side undici error that names
       * neither memory nor the server.
       *
       * ⚠️ **k8s cannot see ZFS ARC, and that is what makes this node deceptive.**
       * maxdata has 32 GB; ARC is capped at 8 GB *outside* the kubelet's accounting,
       * so k8s believes it has ~31 GB allocatable when ~23 GB is real. The node
       * reported `KubeletHasSufficientMemory` throughout, because from its point of
       * view that was true. Pod limits on this host are already ~97% committed before
       * Immich is counted.
       *
       * So these are deliberately modest. They are ceilings that make Immich fail
       * *itself* rather than take the node — and the node hosts Postgres, Paperless,
       * Grafana, Loki and the rest.
       */
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
                // The API pod buffers inbound uploads, so this is the one the
                // OOM-killer actually hit.
                resources: {
                  requests: { memory: "1Gi", cpu: "200m" },
                  limits: { memory: "4Gi", cpu: "4" },
                },
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
                // Thumbnailing and metadata extraction on large video; the
                // heaviest of the three in steady state.
                resources: {
                  requests: { memory: "2Gi", cpu: "500m" },
                  limits: { memory: "6Gi", cpu: "6" },
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
                // CLIP plus the face model, CPU-only. Restarted 8 times during
                // the same OOM episode.
                resources: {
                  requests: { memory: "2Gi", cpu: "500m" },
                  limits: { memory: "4Gi", cpu: "6" },
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

// The host rules, shared by the internal and public Ingresses below so the two
// cannot drift apart.
const immichIngressRules = [
  {
    host: HOSTNAME,
    http: {
      paths: [
        {
          path: "/",
          pathType: "Prefix" as const,
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
];

// The site-local Ingress. This is the one LAN clients hit, and the one that
// owns issuance of `immich-tls` via the cert-manager annotation.
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
      rules: immichIngressRules,
      tls: [{ secretName: "immich-tls", hosts: [HOSTNAME] }],
    },
  },
  { dependsOn: [immich] },
);

// Public Ingress for Immich — the same route, served by the internet-facing
// Traefik on ionos instead of the site-local one.
//
// A second Ingress rather than a class change on the one above: split-horizon
// DNS points *.mvissing.de at the site's own ingress VIP from inside either
// home, so LAN clients keep reaching Immich over the LAN at LAN speed and only
// genuinely external clients traverse ionos. Both name the same TLS Secret.
//
// ⚠️ **No forward-auth in front of this**, and that is a decision rather than an
// omission — the same one taken for Home Assistant, for the same reason.
// Immich's own login is the front door, and with `passwordLogin.enabled: false`
// above that login *is* Authentik: there is no second door to bolt shut.
// Putting the outpost here would protect the browser UI and break the mobile
// app, public share links and every API client, all of which authenticate with
// a bearer token rather than a browser session cookie.
//
// What actually guards this address is therefore Authentik's own login flow:
// TOTP from `auth/authentik-blueprints.ts` for anyone enrolled through it, and
// the reputation policy on `default-authentication-flow`.
//
// ⚠️ **The public path is not the LAN path, and it is not the winkel-pi path
// either.** `traefik-public` runs hostNetwork on ionos and routes straight to
// the pod IP over the WireGuard overlay, so public uploads bypass the
// Raspberry Pi that fronts all internal Winkel ingress (measured at 17.6 MB/s
// — see docs/immich-migration.md §5). They are instead bounded by ionos's
// uplink and maxdata's, which is a different ceiling, not necessarily a higher
// one.
//
// ⚠️ nginx on ionos reaches this entrypoint by **TCP passthrough on :443**,
// splitting on SNI — it never parses the HTTP, so there is no
// `client_max_body_size` in the path and large uploads are not buffered on the
// VPS. That is why full-size video upload from outside works at all.
//
// The three annotations the internal Ingress carries and this one must not —
// the cert-manager issuer, the homepage tile, and the HTTP→HTTPS redirect —
// are explained on the equivalent Authentik Ingress in auth/authentik.ts.
const immichPublicIngress = new k8s.networking.v1.Ingress(
  "immich-public-ingress",
  {
    metadata: {
      name: "immich-public",
      namespace: namespace.metadata.name,
      annotations: {
        // ⚠️ Required. `traefik-public` runs with no Service and with
        // `publishedService` disabled (infrastructure/traefik-public.ts), so it
        // never writes an address into `status.loadBalancer` — and an address
        // appearing there is precisely what Pulumi waits for. Without this the
        // deploy blocks forever, on a resource that is only a declaration.
        "pulumi.com/skipAwait": "true",
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      },
    },
    spec: {
      ingressClassName: publicIngressClass,
      rules: immichIngressRules,
      tls: [{ secretName: "immich-tls", hosts: [HOSTNAME] }],
    },
  },
  { dependsOn: [immich] },
);

export {
  namespace as immichNamespace,
  immich,
  immichIngress,
  immichPublicIngress,
  libraryPVC,
};

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
