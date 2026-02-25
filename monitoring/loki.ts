// Loki - Log aggregation system
// Collects and stores logs from all pods via Promtail
// Queryable from Grafana

import * as k8s from "@pulumi/kubernetes";
import { namespaceName } from "./namespace";

// Install Loki using Helm chart (single binary mode for simplicity)
const loki = new k8s.helm.v3.Chart("loki", {
  chart: "loki",
  version: "6.46.0",
  namespace: namespaceName,
  fetchOpts: {
    repo: "https://grafana.github.io/helm-charts",
  },
  values: {
    // Deployment mode - single binary is simpler, good for small-medium clusters
    // For production HA, use "Distributed" mode
    deploymentMode: "SingleBinary",

    // Disable other deployment modes
    read: {
      replicas: 0,
    },
    write: {
      replicas: 0,
    },
    backend: {
      replicas: 0,
    },

    loki: {
      // Authentication - disabled for internal cluster use
      auth_enabled: false,

      // Storage configuration
      commonConfig: {
        replication_factor: 1,
      },

      storage: {
        type: "filesystem",
        bucketNames: {
          chunks: "chunks",
          ruler: "ruler",
          admin: "admin",
        },
        filesystem: {
          chunks_directory: "/var/loki/chunks",
          rules_directory: "/var/loki/rules",
        },
      },

      // Schema configuration - how logs are stored
      schemaConfig: {
        configs: [
          {
            from: "2024-01-01",
            store: "tsdb",
            object_store: "filesystem",
            schema: "v13",
            index: {
              prefix: "index_",
              period: "24h",
            },
          },
        ],
      },

      // Retention - keep logs for 1 year
      limits_config: {
        retention_period: "365d",
        // Per-stream rate limits (adjust based on your log volume)
        ingestion_rate_mb: 10,
        ingestion_burst_size_mb: 20,
      },

      // Compactor - cleans up old data based on retention
      compactor: {
        retention_enabled: true,
        delete_request_store: "filesystem",
      },

      // Query limits
      querier: {
        max_concurrent: 4,
      },
    },

    // Single binary configuration
    singleBinary: {
      replicas: 1,

      // Persistent storage for logs using local-path (ZFS backed)
      persistence: {
        enabled: true,
        storageClass: "local-path",
        size: "100Gi", // Can be expanded later if needed
      },

      // Resource limits
      resources: {
        requests: {
          cpu: "500m",
          memory: "1Gi",
        },
        limits: {
          cpu: "2",
          memory: "2Gi",
        },
      },
    },

    // Gateway (nginx) - optional, disable if not needed
    gateway: {
      enabled: false,
    },

    // Disable caching - not needed for filesystem storage
    chunksCache: {
      enabled: false,
    },
    resultsCache: {
      enabled: false,
    },

    // Monitoring
    monitoring: {
      selfMonitoring: {
        enabled: false,
        grafanaAgent: {
          installOperator: false,
        },
      },
    },

    // Test pod - disable to save resources
    test: {
      enabled: false,
    },
  },
});

// Create a LoadBalancer service for external access (e.g., from maxdata host)
// This allows Promtail running on bare metal hosts to send logs to Loki
const lokiLoadBalancer = new k8s.core.v1.Service("loki-external", {
  metadata: {
    name: "loki-external",
    namespace: namespaceName,
    labels: {
      "app.kubernetes.io/name": "loki",
      "app.kubernetes.io/component": "external-access",
    },
  },
  spec: {
    type: "LoadBalancer",
    ports: [
      {
        name: "http",
        port: 3100,
        targetPort: 3100,
        protocol: "TCP",
      },
    ],
    selector: {
      "app.kubernetes.io/name": "loki",
      "app.kubernetes.io/component": "single-binary",
    },
  },
}, { dependsOn: [loki] });

// Export Loki service URL for Grafana data source and Promtail
export const lokiUrl = "http://loki.monitoring.svc.cluster.local:3100";
export const lokiExternalIp = lokiLoadBalancer.status.loadBalancer.ingress[0].ip;

export { loki, lokiLoadBalancer };

// Usage:
//
// Loki is queried through Grafana - no direct UI
//
// Query examples (LogQL):
//   - All logs from a namespace:
//     {namespace="monitoring"}
//
//   - Logs from a specific pod:
//     {pod="grafana-xyz"}
//
//   - Search for errors:
//     {namespace="monitoring"} |= "error"
//
//   - JSON log parsing:
//     {namespace="monitoring"} | json | level="error"
//
//   - Rate of log lines:
//     rate({namespace="monitoring"}[5m])
//
// Retention: 1 year (365 days)
// Storage: 100Gi on local-path (ZFS backed with automatic sanoid snapshots)
//
// Note: Logs are shipped to Loki by Promtail (deployed as DaemonSet)
// If storage fills up, expand the PVC or reduce retention period