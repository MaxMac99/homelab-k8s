// Shared PostgreSQL using CloudNativePG Operator.
//
// Two clusters, and they are not interchangeable:
//   - `postgres`        — brink-server, PG 18.4. authentik, homeassistant.
//   - `postgres-winkel` — maxdata, PG 18.4 + VectorChord. grafana, paperless,
//                         immich.
//
// Both run the same major *and minor* version deliberately: one upgrade
// cadence, and `pg_dump` output restores in either direction.
//
// ⚠️ This header used to read "Backups handled by sanoid/syncoid at ZFS pool
// level". That was never true of the Brink cluster — sanoid runs on maxdata's
// pools, and `postgres` has an instance there only as of the (broken) replica.
// Real backups are `databases/backup.ts`: nightly `pg_dump` to `tank`.
//
// See docs/immich-migration.md §3.1–§3.3.

import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import {
  HOSTNAME_LABEL,
  ZONE_LABEL,
  MAXDATA,
  BRINK_SERVER,
} from "../infrastructure/sites";

// Create namespace for database infrastructure
const namespace = new k8s.core.v1.Namespace("database", {
  metadata: {
    name: "database",
  },
});

// Create namespace for CloudNativePG operator
const cnpgNamespace = new k8s.core.v1.Namespace("cnpg-system", {
  metadata: {
    name: "cnpg-system",
  },
});

// Install CloudNativePG operator
const cnpgOperator = new k8s.helm.v3.Chart("cloudnative-pg", {
  chart: "cloudnative-pg",
  version: "0.29.0",
  namespace: cnpgNamespace.metadata.name,
  fetchOpts: {
    repo: "https://cloudnative-pg.github.io/charts",
  },
  values: {
    // Operator configuration
    monitoring: {
      podMonitorEnabled: false, // Disabled - Prometheus Operator not installed
    },
  },
});

// Generate password for authentik user
const authentikPassword = new random.RandomPassword("authentik-db-password", {
  length: 32,
  special: false,
});

// Create secret with password for authentik user
// This will be used by CNPG declarative role management
// Includes Reflector annotations to mirror to authentik namespace
const authentikPasswordSecret = new k8s.core.v1.Secret(
  "postgres-authentik-password",
  {
    metadata: {
      name: "postgres-authentik",
      namespace: namespace.metadata.name,
      annotations: {
        "reflector.v1.k8s.emberstack.com/reflection-auto-enabled": "true",
        "reflector.v1.k8s.emberstack.com/reflection-allowed": "true",
        "reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces":
          "authentik",
        "reflector.v1.k8s.emberstack.com/reflection-auto-namespaces":
          "authentik",
      },
    },
    type: "kubernetes.io/basic-auth",
    stringData: {
      username: "authentik",
      password: authentikPassword.result,
    },
  },
);

// Generate password for grafana user
const grafanaPassword = new random.RandomPassword("grafana-db-password", {
  length: 32,
  special: false,
});

// Create secret with password for grafana user
// This will be used by CNPG declarative role management
// Includes Reflector annotations to mirror to monitoring namespace
const grafanaPasswordSecret = new k8s.core.v1.Secret(
  "postgres-grafana-password",
  {
    metadata: {
      name: "postgres-grafana",
      namespace: namespace.metadata.name,
      annotations: {
        "reflector.v1.k8s.emberstack.com/reflection-auto-enabled": "true",
        "reflector.v1.k8s.emberstack.com/reflection-allowed": "true",
        "reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces":
          "monitoring",
        "reflector.v1.k8s.emberstack.com/reflection-auto-namespaces":
          "monitoring",
      },
    },
    type: "kubernetes.io/basic-auth",
    stringData: {
      username: "grafana",
      password: grafanaPassword.result,
    },
  },
);

// Generate password for paperless user
const paperlessPassword = new random.RandomPassword("paperless-db-password", {
  length: 32,
  special: false,
});

// Create secret with password for paperless user
// This will be used by CNPG declarative role management
// Includes Reflector annotations to mirror to paperless namespace
const paperlessPasswordSecret = new k8s.core.v1.Secret(
  "postgres-paperless-password",
  {
    metadata: {
      name: "postgres-paperless",
      namespace: namespace.metadata.name,
      annotations: {
        "reflector.v1.k8s.emberstack.com/reflection-auto-enabled": "true",
        "reflector.v1.k8s.emberstack.com/reflection-allowed": "true",
        "reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces":
          "paperless",
        "reflector.v1.k8s.emberstack.com/reflection-auto-namespaces":
          "paperless",
      },
    },
    type: "kubernetes.io/basic-auth",
    stringData: {
      username: "paperless",
      password: paperlessPassword.result,
    },
  },
);

// Generate password for homeassistant user
const homeassistantPassword = new random.RandomPassword(
  "homeassistant-db-password",
  {
    length: 32,
    special: false,
  },
);

// Create secret with password for homeassistant user
// This will be used by CNPG declarative role management
// Includes Reflector annotations to mirror to homeassistant namespace
const homeassistantPasswordSecret = new k8s.core.v1.Secret(
  "postgres-homeassistant-password",
  {
    metadata: {
      name: "postgres-homeassistant",
      namespace: namespace.metadata.name,
      annotations: {
        "reflector.v1.k8s.emberstack.com/reflection-auto-enabled": "true",
        "reflector.v1.k8s.emberstack.com/reflection-allowed": "true",
        "reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces":
          "homeassistant",
        "reflector.v1.k8s.emberstack.com/reflection-auto-namespaces":
          "homeassistant",
      },
    },
    type: "kubernetes.io/basic-auth",
    stringData: {
      username: "homeassistant",
      password: homeassistantPassword.result,
    },
  },
);

// Generate password for immich user
const immichPassword = new random.RandomPassword("immich-db-password", {
  length: 32,
  special: false,
});

// Create secret with password for immich user
// This will be used by CNPG declarative role management
// Includes Reflector annotations to mirror to immich namespace
const immichPasswordSecret = new k8s.core.v1.Secret(
  "postgres-immich-password",
  {
    metadata: {
      name: "postgres-immich",
      namespace: namespace.metadata.name,
      annotations: {
        "reflector.v1.k8s.emberstack.com/reflection-auto-enabled": "true",
        "reflector.v1.k8s.emberstack.com/reflection-allowed": "true",
        "reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces":
          "immich",
        "reflector.v1.k8s.emberstack.com/reflection-auto-namespaces": "immich",
      },
    },
    type: "kubernetes.io/basic-auth",
    stringData: {
      username: "immich",
      password: immichPassword.result,
    },
  },
);

/**
 * ⚠️ Migration window only — flip to `false` once `postgres-winkel` has
 * finished bootstrapping.
 *
 * `bootstrap.initdb.import` with `type: monolith` runs `pg_dump` against this
 * cluster for *two* databases with *different* owners, plus their roles. No
 * per-app role can do that, so the import connects as `postgres` — which
 * requires CNPG to generate the `postgres-superuser` Secret, which it only does
 * when this is true. It has been `false` since the cluster was built.
 *
 * Leaving it true afterwards means a password-authenticated superuser sitting
 * in a Secret for no reason. A4 turns it back off.
 */
const MIGRATION_IMPORT_WINDOW = false;

/**
 * ⚠️ Phase A4 — staged behind Phase B, deliberately.
 *
 * Flipping this to `true` deletes `postgres-1`, the replica that has never
 * replayed a transaction since 2026-08-19 (§3.3). It is nearly worthless as a
 * recovery source — five days stale and stuck in a broken recovery state — but
 * it is not *literally* nothing, and until `databases/backup.ts` has produced a
 * dump that someone has actually looked at, it is the only other copy of
 * authentik and homeassistant that exists.
 *
 * So: land Phase B, run the CronJob by hand, verify real dumps on `tank`, then
 * flip this. That ordering is the whole reason B sequences before A4.
 *
 * ⚠️ Leaving it `false` is not a steady state either — it keeps a replica that
 * does not work and reports itself healthy.
 */
const RETIRE_BROKEN_REPLICA = true;

// PostgreSQL Cluster using CloudNativePG
const postgresCluster = new k8s.apiextensions.CustomResource(
  "postgres-cluster",
  {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: {
      name: "postgres",
      namespace: namespace.metadata.name,
    },
    spec: {
      // One instance, at Brink. Serves authentik and homeassistant only.
      //
      // ⚠️ This was `instances: 2`, and the comment here claimed the second
      // instance "is what lets Authentik survive maxdata". That was wrong in
      // two separate ways, and both are worth recording so nobody restores the
      // replica on the strength of the old reasoning:
      //
      // 1. Authentik cannot survive a Brink outage regardless of its database.
      //    `auth/authentik.ts:151,291,368` pin all three Authentik pods to
      //    `onNode(BRINK_SERVER)`. A replica at Winkel protected a database
      //    whose only consumers were already gone.
      // 2. The replica had never worked. `postgres-1` was created 2026-08-19
      //    and never replayed a single transaction — the primary had recycled
      //    a WAL segment before it fetched one, no slot held it, no archive to
      //    fall back on, and a past failover left it on the wrong timeline. It
      //    sat ~41 GB behind, retrying every 5 s, while CNPG reported the
      //    cluster `2/2 ready, healthy`. Nothing surfaced it for three days.
      //
      // So the estate's real exposure was never "one site" — it was that every
      // database existed as exactly one copy with no backup. Replication was
      // the wrong tool for that: it faithfully propagates corruption and
      // accidental deletion, and the whole estate is 135 MB. `databases/backup.ts`
      // takes nightly `pg_dump`s to `tank` instead, which covers the disk
      // failure the replica was nominally for *and* the two cases it wasn't.
      //
      // See docs/immich-migration.md §3.2 and §3.3.
      instances: RETIRE_BROKEN_REPLICA ? 1 : 2,

      // See MIGRATION_IMPORT_WINDOW above. Should be false in steady state.
      enableSuperuserAccess: MIGRATION_IMPORT_WINDOW,

      // PostgreSQL configuration
      imageName: "ghcr.io/cloudnative-pg/postgresql:18.4",

      // Storage configuration - use fast ZFS pool
      storage: {
        storageClass: "local-path",
        size: "50Gi",
      },

      // WAL storage (can be same or separate)
      walStorage: {
        storageClass: "local-path",
        size: "10Gi",
      },

      // Bootstrap - initialize new cluster
      bootstrap: {
        initdb: {
          database: "app",
          owner: "app",
          // Secret will be auto-generated by CNPG as: postgres-app
        },
      },

      // Declarative role management - create roles for applications
      managed: {
        roles: [
          {
            name: "authentik",
            ensure: "present",
            login: true,
            passwordSecret: {
              name: authentikPasswordSecret.metadata.name,
            },
          },
          // ⚠️ Kept until A4. Removing them here while Grafana and Paperless
          // still run against this cluster would strand them mid-cutover; the
          // Winkel cluster declares its own copies, so there is a brief overlap
          // where both clusters manage a role of the same name. That is fine —
          // they are set from the same Secret.
          ...(RETIRE_BROKEN_REPLICA
            ? []
            : [
                {
                  name: "grafana",
                  ensure: "present",
                  login: true,
                  passwordSecret: { name: grafanaPasswordSecret.metadata.name },
                },
                {
                  name: "paperless",
                  ensure: "present",
                  login: true,
                  passwordSecret: {
                    name: paperlessPasswordSecret.metadata.name,
                  },
                },
              ]),
          {
            name: "homeassistant",
            ensure: "present",
            login: true,
            passwordSecret: {
              name: homeassistantPasswordSecret.metadata.name,
            },
          },
        ],
      },

      // Note: PgBouncer pooling can be added later as a separate Pooler resource if needed
      // The pgbouncer field is not supported in the Cluster spec for this CNPG version

      // Resource limits
      resources: {
        requests: {
          memory: "2Gi", // Must be >= shared_buffers (1GB) + overhead
          cpu: "500m",
        },
        limits: {
          memory: "4Gi",
          cpu: "2",
        },
      },

      // PostgreSQL configuration parameters
      postgresql: {
        parameters: {
          max_connections: "200",
          shared_buffers: "1GB",
          effective_cache_size: "3GB",
          maintenance_work_mem: "256MB",
          checkpoint_completion_target: "0.9",
          wal_buffers: "16MB",
          default_statistics_target: "100",
          random_page_cost: "1.1", // Optimized for SSD/NVMe
          effective_io_concurrency: "200",
          work_mem: "5MB",
          min_wal_size: "1GB",
          max_wal_size: "4GB",
        },
      },

      // Add Prometheus scrape annotations to pods (metrics on port 9187)
      inheritedMetadata: {
        annotations: {
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9187",
        },
      },

      // ⚠️ Still no CNPG-native backup stanza, and that is now a considered
      // position rather than an oversight. CNPG's backup targets S3-compatible
      // object storage; the offsite target here is a Hetzner Storage Box, which
      // is SFTP/WebDAV and a different product. `databases/backup.ts` takes
      // nightly logical dumps to `tank` instead.
      //
      // ⚠️ The comment that used to sit here claimed sanoid/syncoid on maxdata's
      // pools covered this cluster. They do not — this cluster runs at Brink,
      // on `main/root`, which sanoid never sees.

      // Pinned to brink-server, which is where its two consumers already live:
      // Authentik pins all three pods there, and Home Assistant is at Brink
      // because the devices are.
      //
      // ⚠️ A *node* pin, not a site pin, and that is deliberate — this cluster
      // holds a `local-path` volume, which is genuinely node-local with no
      // cross-site replication (D6). local-path stamps `nodeAffinity` onto the
      // PV at first bind, so a bound volume already cannot move; the pin is
      // what decides where that first bind happens, which is permanent.
      //
      // The zone anti-affinity that used to be here is gone with the second
      // instance — there is nothing left to keep apart.
      //
      // ⚠️ While RETIRE_BROKEN_REPLICA is false the *old* two-node placement has
      // to stay, or `postgres-1` becomes unschedulable the moment it restarts —
      // pinning to Brink while a second instance still exists is not a smaller
      // change than deleting it, it is a worse one.
      affinity: RETIRE_BROKEN_REPLICA
        ? {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [
                  {
                    matchExpressions: [
                      {
                        key: HOSTNAME_LABEL,
                        operator: "In",
                        values: [BRINK_SERVER],
                      },
                    ],
                  },
                ],
              },
            },
          }
        : {
            enablePodAntiAffinity: true,
            topologyKey: ZONE_LABEL,
            podAntiAffinityType: "required",
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [
                  {
                    matchExpressions: [
                      {
                        key: HOSTNAME_LABEL,
                        operator: "In",
                        values: [MAXDATA, BRINK_SERVER],
                      },
                    ],
                  },
                ],
              },
            },
          },
    },
  },
  { dependsOn: [cnpgOperator, namespace] },
);

// ---------------------------------------------------------------------------
// postgres-winkel — Grafana, Paperless and Immich, at Winkel.
//
// See docs/immich-migration.md §3.1 and Phase A1.
//
// ⚠️ The plan this implements originally called for *two* new clusters: a
// PG17.5 one for Immich (VectorChord had no PG18 build) and a PG18.4 one for
// Grafana and Paperless, because `pg_dump` is forward-compatible only and they
// could not move down to 17. That premise expired — VectorChord 1.0 ships
// PG18 — so this is one cluster at 18.4, the same minor the Brink cluster runs.
// Keeping both clusters on the same minor is deliberate: one upgrade cadence,
// and dumps restore in either direction.
// ---------------------------------------------------------------------------
const postgresWinkelCluster = new k8s.apiextensions.CustomResource(
  "postgres-winkel-cluster",
  {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: {
      name: "postgres-winkel",
      namespace: namespace.metadata.name,
    },
    spec: {
      // Single instance, deliberately. Replication was dropped estate-wide:
      // the risk being managed is a site outage, and replication does not help
      // there — Immich's photos on `tank`, Paperless's NFS media and Grafana's
      // local-path volume are all single-site regardless, so a replica at Brink
      // would start with nothing to serve. Nightly dumps (databases/backup.ts)
      // cover disk failure *and* the corruption and accidental deletion that
      // replication would have faithfully copied. See §3.2.
      instances: 1,

      // ⚠️ Pinned exactly, and *not* the community PostgreSQL image. This is
      // the CNPG operand image with VectorChord compiled in, which Immich needs
      // for its face and CLIP embeddings.
      //
      // The 18.4 must track `postgres` above — see the note on this cluster.
      // Renovate picks this up via the existing `imageName:` regex manager.
      imageName: "ghcr.io/tensorchord/cloudnative-vectorchord:18.4-1.1.1",

      // Grafana is 14 MB and Paperless 32 MB; effectively all of this is for
      // Immich, whose row count scales with ~170k assets plus face embeddings.
      // /fast had 458 G free on 2026-08-22.
      storage: {
        storageClass: "local-path",
        size: "100Gi",
      },
      walStorage: {
        storageClass: "local-path",
        size: "20Gi",
      },

      // Bootstrap by importing grafana and paperless off the Brink cluster.
      //
      // CNPG runs pg_dump/pg_restore over the network for us. `monolith` (as
      // opposed to `microservice`) is what allows more than one database in a
      // single import and brings the owning roles across with them.
      //
      // ⚠️ This is a point-in-time copy, not a sync. Anything written to the
      // old cluster after the dump starts is lost. Quiesce Grafana and
      // Paperless across the cutover — at 46 MB combined it is a minutes-long
      // window, but it is not a zero-length one.
      //
      // ⚠️ This whole block is dead weight after the first successful
      // bootstrap: CNPG only consults `bootstrap` when the cluster has no data
      // directory. Re-running `pulumi up` will not re-import, and *deleting the
      // cluster to "retry" would discard everything written since.*
      bootstrap: {
        initdb: {
          import: {
            type: "monolith",
            databases: ["grafana", "paperless"],
            roles: ["grafana", "paperless"],
            source: {
              externalCluster: "postgres-brink",
            },
          },
        },
      },

      // Source for the import above. Connects as `postgres` because a monolith
      // import dumps two databases with different owners plus their roles, and
      // no per-app role can do that — see MIGRATION_IMPORT_WINDOW.
      //
      // `postgres-superuser` is generated by CNPG, not by Pulumi, and only
      // exists while that flag is true.
      externalClusters: [
        {
          name: "postgres-brink",
          connectionParameters: {
            host: "postgres-rw.database.svc.cluster.local",
            user: "postgres",
            dbname: "postgres",
            sslmode: "require",
          },
          password: {
            name: "postgres-superuser",
            key: "password",
          },
        },
      ],

      // All three roles are declared here, including the two the import above
      // already creates.
      //
      // ⚠️ That overlap is deliberate and both halves are needed:
      //   - the *import* must create grafana and paperless before it restores,
      //     or there is no role to own the restored objects; and
      //   - declaring them *here* is what guarantees the passwords. CNPG's role
      //     import goes through `pg_dumpall -r`, and whether the password hashes
      //     survive that is a detail of the operator, not something this repo
      //     controls. Setting them explicitly from the same Secrets the apps
      //     already read makes the question moot — worst case CNPG re-sets a
      //     password to the value it already had.
      managed: {
        roles: [
          {
            name: "grafana",
            ensure: "present",
            login: true,
            passwordSecret: {
              name: grafanaPasswordSecret.metadata.name,
            },
          },
          {
            name: "paperless",
            ensure: "present",
            login: true,
            passwordSecret: {
              name: paperlessPasswordSecret.metadata.name,
            },
          },
          {
            name: "immich",
            ensure: "present",
            login: true,
            passwordSecret: {
              name: immichPasswordSecret.metadata.name,
            },
          },
        ],
      },

      resources: {
        requests: {
          memory: "3Gi", // >= shared_buffers (1GB) + maintenance_work_mem headroom
          cpu: "500m",
        },
        limits: {
          memory: "8Gi",
          cpu: "4",
        },
      },

      postgresql: {
        // ⚠️ Without this VectorChord's index access method is not registered
        // and `CREATE EXTENSION vchord` fails. It is a shared library, so it
        // has to be preloaded at postmaster start — it cannot be turned on for
        // one database later.
        shared_preload_libraries: ["vchord"],

        parameters: {
          max_connections: "200",
          shared_buffers: "1GB",
          effective_cache_size: "6GB",
          // ⚠️ 8x the Brink cluster's 256MB, and the reason this cluster gets
          // a bigger memory limit. Building the vector index over ~1M
          // embeddings is the single operation that needs it; everything else
          // here would be happy with the old value.
          maintenance_work_mem: "2GB",
          checkpoint_completion_target: "0.9",
          wal_buffers: "16MB",
          default_statistics_target: "100",
          random_page_cost: "1.1", // Optimized for SSD/NVMe
          effective_io_concurrency: "200",
          work_mem: "8MB",
          min_wal_size: "1GB",
          max_wal_size: "4GB",
        },
      },

      inheritedMetadata: {
        annotations: {
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9187",
        },
      },

      // Pinned to maxdata, the node with the ZFS pools. Immich's library lives
      // on `tank` via NFS on this same machine, and Grafana's and Paperless's
      // storage is here too, so this is where "local database" was the point.
      //
      // ⚠️ A node pin rather than a site pin: Winkel has two nodes, and
      // winkel-pi is a Raspberry Pi booting from USB-SATA. `local-path` is
      // node-local and stamps nodeAffinity onto the PV at first bind, so
      // landing there once would be permanent.
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [
              {
                matchExpressions: [
                  {
                    key: HOSTNAME_LABEL,
                    operator: "In",
                    values: [MAXDATA],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  },
  { dependsOn: [cnpgOperator, namespace, postgresCluster] },
);

// Immich's database.
//
// ⚠️ `extensions` here is what keeps Immich's role off superuser. Immich asks
// for superuser by default because it wants to run `CREATE EXTENSION` itself;
// declaring the extensions on the Database CR has CNPG do it as the operator
// instead, so the `immich` role never needs the privilege. See Phase A1.
//
// That mattered more once this became a shared cluster — superuser here would
// have reached Grafana's and Paperless's data too.
const immichDatabase = new k8s.apiextensions.CustomResource(
  "immich-database",
  {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Database",
    metadata: {
      name: "immich-db",
      namespace: namespace.metadata.name,
    },
    spec: {
      name: "immich",
      owner: "immich",
      cluster: {
        name: "postgres-winkel",
      },
      // ⚠️ Explicit, though it is also the default. This is the difference
      // between removing a Database CR and DROPping a database.
      databaseReclaimPolicy: "retain",
      //
      // ⚠️ Order matters, and two of these are dependencies the plan's
      // `extensions: [vchord, earthdistance]` did not list. CNPG issues a plain
      // `CREATE EXTENSION`, never `CASCADE`, so every dependency has to be named
      // explicitly and before its dependent:
      //
      //   vector        — VectorChord is built on pgvector and supplies no type
      //                   of its own. Without it `CREATE EXTENSION vchord` fails
      //                   with `required extension "vector" is not installed`,
      //                   which is exactly what happened on the first apply.
      //   cube          — earthdistance is a thin wrapper over it.
      //
      // Both ship in the tensorchord image already; they only needed declaring.
      extensions: [
        { name: "vector", ensure: "present" },
        { name: "vchord", ensure: "present" },
        { name: "cube", ensure: "present" },
        { name: "earthdistance", ensure: "present" },
      ],
    },
  },
  { dependsOn: [postgresWinkelCluster] },
);

// Service for applications to connect (automatically created by CNPG)
// postgres-rw.database.svc.cluster.local:5432 - read-write service (primary)
// postgres-ro.database.svc.cluster.local:5432 - read-only service (replicas)
// postgres-r.database.svc.cluster.local:5432 - any instance

export const postgresqlNamespace = namespace.metadata.name;
export const postgresqlClusterName = postgresCluster.metadata.name;
export const postgresWinkelClusterName = postgresWinkelCluster.metadata.name;

// Connection information for applications:
export const postgresqlHost = "postgres-rw.database.svc.cluster.local";
export const postgresqlReadOnlyHost = "postgres-ro.database.svc.cluster.local";
export const postgresqlPort = 5432;

/** Winkel cluster: grafana, paperless, immich. See §3.1. */
export const postgresWinkelHost =
  "postgres-winkel-rw.database.svc.cluster.local";
export const postgresWinkelReadOnlyHost =
  "postgres-winkel-ro.database.svc.cluster.local";

// Export passwords for creating secrets in app namespaces (workaround for Reflector issues)
export const authentikDbPassword = authentikPassword.result;
export const grafanaDbPassword = grafanaPassword.result;
export const paperlessDbPassword = paperlessPassword.result;
export const homeassistantDbPassword = homeassistantPassword.result;
export const immichDbPassword = immichPassword.result;

export { immichDatabase };

// Instructions for creating new databases:
//
// RECOMMENDED: Use declarative Database CRD with shared 'app' user (see authentik.ts for example)
//
// 1. Create a Database resource in your Pulumi code:
//    const myappDatabase = new k8s.apiextensions.CustomResource("myapp-database", {
//      apiVersion: "postgresql.cnpg.io/v1",
//      kind: "Database",
//      metadata: {
//        name: "myapp-db",
//        namespace: "database",
//      },
//      spec: {
//        name: "myapp",        // Database name
//        owner: "app",         // Use shared 'app' user from cluster bootstrap
//        cluster: {
//          name: "postgres",   // This cluster
//        },
//      },
//    });
//
// 2. CNPG will automatically create the database owned by the 'app' user
//
// 3. Applications connect using the shared 'postgres-app' secret:
//    - Host: postgres-rw.database.svc.cluster.local (read-write)
//    - Host: postgres-ro.database.svc.cluster.local (read-only)
//    - Port: 5432
//    - Username: app (stored in secret as "username")
//    - Password: (stored in secret as "password")
//
// Note: Using a shared 'app' user simplifies credential management. All application
// databases can use the same credentials. For isolation, create separate users per app
// by specifying a different owner name (CNPG will create the role automatically).
//
// ALTERNATIVE: Manual database creation (not recommended)
//
// 1. Get the superuser password:
//    kubectl get secret -n database postgres-superuser -o jsonpath='{.data.password}' | base64 -d
//
// 2. Connect to PostgreSQL:
//    kubectl exec -it -n database postgres-1 -- psql -U postgres
//
// 3. Create database and user manually:
//    CREATE DATABASE myapp;
//    CREATE USER myapp WITH PASSWORD 'your_secure_password';
//    GRANT ALL PRIVILEGES ON DATABASE myapp TO myapp;
//    ALTER DATABASE myapp OWNER TO myapp;
//    \c myapp
//    GRANT ALL ON SCHEMA public TO myapp;
//    \q
//
// Other operations:
//
// ⚠️ The block that used to be here suggested `kubectl patch ... instances: 3`
// to "scale to HA", and described a backup strategy of sanoid/syncoid over
// `/mnt/k8s-fast/local-path-provisioner`. Both are wrong now and were removed:
//
//   - `/mnt/k8s-fast` was a virtiofs mount shared by microVMs on maxdata. Those
//     microVMs no longer exist. Paths are `/fast/k8s/local-path` on maxdata and
//     `/var/lib/k8s/local-path` on brink-server, and they are genuinely
//     node-local.
//   - Scaling `postgres` back up is not a fix for anything. Only maxdata and
//     brink-server can hold a local-path volume at all, so 3 has nowhere to
//     live, and 2 is what was just removed — see the `instances` comment above
//     for why the replica was worse than useless.
//
// Backup strategy: `databases/backup.ts`. Restore procedure is documented at
// the bottom of that file.
//
// Check replication/health honestly, rather than trusting `READY 1/1`:
//   kubectl get cluster -n database
//   kubectl exec -n database postgres-1 -c postgres -- \
//     psql -tAc "select pg_last_xact_replay_timestamp()"
// ⚠️ A NULL there on a designated replica means it has never replayed anything,
// which is exactly what CNPG reported as "Cluster in healthy state" for three
// days in August 2026.
