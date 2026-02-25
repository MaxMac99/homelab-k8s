// Grafana Database Configuration
// Creates a dedicated PostgreSQL database for Grafana using CloudNativePG
// Stores dashboards, users, sessions, and other Grafana configuration

import * as k8s from "@pulumi/kubernetes";
import {
  postgresqlHost,
  postgresqlNamespace,
  postgresqlClusterName,
  grafanaDbPassword,
} from "../postgresql";
import { namespaceName } from "./namespace";

// Declaratively create Grafana database using CloudNativePG
// Uses the 'grafana' user created via declarative role management
const grafanaDatabase = new k8s.apiextensions.CustomResource("grafana-database", {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Database",
  metadata: {
    name: "grafana-db",
    namespace: postgresqlNamespace,
  },
  spec: {
    name: "grafana",
    owner: "grafana", // Use per-app user from declarative role management
    cluster: {
      name: postgresqlClusterName,
    },
  },
});

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
export const grafanaDatabaseHost = postgresqlHost;
export const grafanaDatabaseName = "grafana";
export const grafanaDatabaseUser = "grafana";
export const grafanaDatabaseSecretName = postgresSecret.metadata.name;

export { grafanaDatabase, postgresSecret };

// PostgreSQL connection info for Grafana:
//   Host: postgres-rw.database.svc.cluster.local
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