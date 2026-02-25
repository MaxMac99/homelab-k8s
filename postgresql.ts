// Shared PostgreSQL using CloudNativePG Operator
// Provides HA, connection pooling, and monitoring
// Uses fast ZFS pool for maximum performance
// Backups handled by sanoid/syncoid at ZFS pool level

import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";

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
  version: "0.26.1",
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
      instances: 1, // Start with 1, can scale to 3 for HA later

      // PostgreSQL configuration
      imageName: "ghcr.io/cloudnative-pg/postgresql:18.1",

      // Storage configuration - use fast ZFS pool
      storage: {
        storageClass: "local-path", // K3s default, points to /mnt/k8s-fast via config
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

      // Note: No CloudNativePG backup configuration
      // Backups are handled by sanoid/syncoid at the ZFS pool level
      // - Sanoid creates snapshots on fast pool (48 hourly, 30 daily, 6 monthly)
      // - Syncoid replicates to tank pool for off-pool backup

      // Node affinity - can run on any k3s node since /mnt/k8s-fast is shared via virtiofs
      // The local-path provisioner will bind to whichever node it schedules on first
    },
  },
  { dependsOn: [cnpgOperator, namespace] },
);

// Service for applications to connect (automatically created by CNPG)
// postgres-rw.database.svc.cluster.local:5432 - read-write service (primary)
// postgres-ro.database.svc.cluster.local:5432 - read-only service (replicas)
// postgres-r.database.svc.cluster.local:5432 - any instance

export const postgresqlNamespace = namespace.metadata.name;
export const postgresqlClusterName = postgresCluster.metadata.name;

// Connection information for applications:
export const postgresqlHost = "postgres-rw.database.svc.cluster.local";
export const postgresqlReadOnlyHost = "postgres-ro.database.svc.cluster.local";
export const postgresqlPort = 5432;

// Export passwords for creating secrets in app namespaces (workaround for Reflector issues)
export const authentikDbPassword = authentikPassword.result;
export const grafanaDbPassword = grafanaPassword.result;
export const paperlessDbPassword = paperlessPassword.result;
export const homeassistantDbPassword = homeassistantPassword.result;

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
// 1. Scale to HA (3 replicas):
//    kubectl patch cluster -n database postgres --type merge -p '{"spec":{"instances":3}}'
//
// 2. View ZFS snapshots (on maxdata host):
//    zfs list -t snapshot | grep fast/k8s
//    zfs list -t snapshot | grep tank/fast-backup/k8s  # Replicated backups
//
// 3. Restore from ZFS snapshot:
//    zfs rollback fast/k8s@snapshot-name  # Rollback to a snapshot
//    # Or clone a snapshot to a new dataset for recovery
//
// Backup Strategy:
// - Data stored at: /mnt/k8s-fast/local-path-provisioner (any k3s node)
// - Local snapshots: Sanoid on fast pool (48 hourly, 30 daily, 6 monthly)
// - Off-pool backup: Syncoid replicates to tank/fast-backup/k8s
// - No CloudNativePG backup configuration (using native ZFS snapshots instead)
