// Grafana Database Configuration
// Creates a dedicated PostgreSQL database for Grafana using CloudNativePG
// Stores dashboards, users, sessions, and other Grafana configuration

import * as k8s from "@pulumi/kubernetes";
import {
  postgresqlNamespace,
  postgresWinkelHost,
  postgresWinkelClusterName,
  grafanaDbPassword,
} from "../databases/postgresql";
import { namespaceName } from "./namespace";

// Declaratively manage the Grafana database on the Winkel cluster.
//
// ⚠️ The Kubernetes object is named `grafana-winkel-db`, not `grafana-db`, and
// that is forced rather than stylistic: `Database.spec.cluster` carries a CEL
// validation of `self == oldSelf` ("cluster reference is immutable after
// creation"). Repointing the existing `grafana-db` at another cluster is
// rejected by the API server, so the move is a new object plus removal of the
// old one, not an edit.
//
// ⚠️ The database itself is created by `postgres-winkel`'s bootstrap import,
// not by this CR — this adopts it and keeps it declaratively managed. The old
// `grafana-db` CR disappearing does *not* drop the database on the Brink
// cluster: its reclaim policy is `retain`, which is what leaves a rollback copy
// in place until Phase B's dumps are proven.
const grafanaDatabase = new k8s.apiextensions.CustomResource(
  "grafana-database-winkel",
  {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Database",
    metadata: {
      name: "grafana-winkel-db",
      namespace: postgresqlNamespace,
    },
    spec: {
      name: "grafana",
      owner: "grafana", // Use per-app user from declarative role management
      cluster: {
        name: postgresWinkelClusterName,
      },
      databaseReclaimPolicy: "retain",
    },
  },
);

// Create postgres-grafana secret directly in monitoring namespace
// (Workaround for Reflector mirroring issues - creating it directly instead)
const postgresSecret = new k8s.core.v1.Secret("postgres-grafana-secret", {
  metadata: {
    name: "postgres-grafana",
    namespace: namespaceName,
  },
  type: "kubernetes.io/basic-auth",
  stringData: {
    username: "grafana",
    password: grafanaDbPassword,
  },
});

// Export database connection details for Grafana
export const grafanaDatabaseHost = postgresWinkelHost;
export const grafanaDatabaseName = "grafana";
export const grafanaDatabaseUser = "grafana";
export const grafanaDatabaseSecretName = postgresSecret.metadata.name;

export { grafanaDatabase, postgresSecret };

// PostgreSQL connection info for Grafana:
//   Host: postgres-winkel-rw.database.svc.cluster.local
//   Port: 5432
//   Database: grafana
//   Username: grafana (from secret postgres-grafana)
//   Password: (from secret postgres-grafana)
//
// Grafana will use this database for:
//   - User accounts and authentication
//   - Dashboards and folder structure
//   - Data sources configuration
//   - Alert rules and notifications
//   - User preferences and settings
//   - API keys and sessions
//
// Benefits over SQLite:
//   - Better performance with multiple users
//   - Supports multiple Grafana instances (HA)
//   - Automatic backups via ZFS snapshots
//   - Better reliability and data integrity
