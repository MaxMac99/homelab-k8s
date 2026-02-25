// Shared Redis Instance
// Provides caching, sessions, and pub/sub for all applications
// Uses fast ZFS pool for persistence

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Redis will be deployed in the database namespace alongside PostgreSQL
// Import the namespace from postgresql.ts
import { postgresqlNamespace } from "./postgresql";

// PVC for Redis persistence (created first)
const redisPVC = new k8s.core.v1.PersistentVolumeClaim("redis-pvc", {
  metadata: {
    name: "redis-data",
    namespace: postgresqlNamespace,
  },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "local-path",
    resources: {
      requests: {
        storage: "10Gi",
      },
    },
  },
});

// Redis Deployment with persistence
const redisDeployment = new k8s.apps.v1.Deployment("redis", {
  metadata: {
    name: "redis",
    namespace: postgresqlNamespace,
    labels: {
      app: "redis",
    },
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        app: "redis",
      },
    },
    template: {
      metadata: {
        labels: {
          app: "redis",
        },
        annotations: {
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9121",
        },
      },
      spec: {
        containers: [
          {
            name: "redis",
            image: "redis:8.4.0-alpine",
            args: [
              "redis-server",
              "--appendonly", "yes",
              "--appendfsync", "everysec",
              "--maxmemory", "1gb",
              "--maxmemory-policy", "allkeys-lru",
            ],
            ports: [{
              containerPort: 6379,
              name: "redis",
            }],
            volumeMounts: [{
              name: "data",
              mountPath: "/data",
            }],
            resources: {
              requests: {
                memory: "256Mi",
                cpu: "100m",
              },
              limits: {
                memory: "2Gi",
                cpu: "1000m",
              },
            },
            livenessProbe: {
              exec: {
                command: ["redis-cli", "ping"],
              },
              initialDelaySeconds: 30,
              periodSeconds: 10,
            },
            readinessProbe: {
              exec: {
                command: ["redis-cli", "ping"],
              },
              initialDelaySeconds: 5,
              periodSeconds: 5,
            },
          },
          {
            name: "redis-exporter",
            image: "oliver006/redis_exporter:v1.66.0",
            ports: [{
              containerPort: 9121,
              name: "metrics",
            }],
            resources: {
              requests: {
                memory: "32Mi",
                cpu: "10m",
              },
              limits: {
                memory: "64Mi",
                cpu: "100m",
              },
            },
          },
        ],
        volumes: [{
          name: "data",
          persistentVolumeClaim: {
            claimName: "redis-data",
          },
        }],
      },
    },
  },
}, { dependsOn: redisPVC });

// Redis Service
const redisService = new k8s.core.v1.Service("redis-service", {
  metadata: {
    name: "redis",
    namespace: postgresqlNamespace,
    labels: {
      app: "redis",
    },
  },
  spec: {
    type: "ClusterIP",
    selector: {
      app: "redis",
    },
    ports: [{
      port: 6379,
      targetPort: 6379,
      name: "redis",
    }],
  },
});

// Export connection info for applications
export const redisHost = pulumi.interpolate`${redisService.metadata.name}.${postgresqlNamespace}.svc.cluster.local`;
export const redisPort = 6379;

// Instructions for applications:
//
// Connect to Redis using:
//   Host: redis.database.svc.cluster.local
//   Port: 6379
//   No password (within cluster - consider adding auth for production)
//
// Example connection strings:
//   - Authentik: redis://redis.database.svc.cluster.local:6379
//   - Generic: redis.database.svc.cluster.local:6379
//
// Data stored at: /mnt/k8s-fast/local-path-provisioner (backed by sanoid/syncoid)
//
// Redis configuration:
//   - AOF persistence enabled (appendonly)
//   - 1GB max memory with LRU eviction
//   - Persistence to disk every second
//
// Optional: Add Redis password for production:
//   1. Create a secret with REDIS_PASSWORD
//   2. Update args to include --requirepass
//   3. Update application configs to use password