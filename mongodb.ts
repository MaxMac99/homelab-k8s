// Shared MongoDB Instance
// Provides document database for applications (primarily UniFi)
// Uses fast ZFS pool for persistence

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

// MongoDB will be deployed in the database namespace alongside PostgreSQL
// Import the namespace from postgresql.ts
import { postgresqlNamespace } from "./postgresql";

// Generate random password for MongoDB root user
const mongodbRootPassword = new random.RandomPassword("mongodb-root-password", {
  length: 32,
  special: false,
});

// MongoDB credentials secret
const mongodbSecret = new k8s.core.v1.Secret("mongodb-secret", {
  metadata: {
    name: "mongodb-credentials",
    namespace: postgresqlNamespace,
  },
  type: "Opaque",
  stringData: {
    rootPassword: mongodbRootPassword.result,
  },
});

// PVC for MongoDB persistence
const mongodbPVC = new k8s.core.v1.PersistentVolumeClaim("mongodb-pvc", {
  metadata: {
    name: "mongodb-data",
    namespace: postgresqlNamespace,
  },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "local-path",
    resources: {
      requests: {
        storage: "50Gi",
      },
    },
  },
});

// MongoDB Deployment with persistence
const mongodbDeployment = new k8s.apps.v1.Deployment("mongodb", {
  metadata: {
    name: "mongodb",
    namespace: postgresqlNamespace,
    labels: {
      app: "mongodb",
    },
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        app: "mongodb",
      },
    },
    template: {
      metadata: {
        labels: {
          app: "mongodb",
        },
        annotations: {
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9216",
        },
      },
      spec: {
        nodeSelector: {
          "kubernetes.io/arch": "amd64",
        },
        containers: [
          {
            name: "mongodb",
            image: "mongo:8.0",
            args: [
              "--auth",
            ],
            ports: [{
              containerPort: 27017,
              name: "mongodb",
            }],
            env: [
              {
                name: "MONGO_INITDB_ROOT_USERNAME",
                value: "root",
              },
              {
                name: "MONGO_INITDB_ROOT_PASSWORD",
                valueFrom: {
                  secretKeyRef: {
                    name: mongodbSecret.metadata.name,
                    key: "rootPassword",
                  },
                },
              },
            ],
            volumeMounts: [{
              name: "data",
              mountPath: "/data/db",
            }],
            resources: {
              requests: {
                memory: "512Mi",
                cpu: "250m",
              },
              limits: {
                memory: "2Gi",
                cpu: "1000m",
              },
            },
            livenessProbe: {
              exec: {
                command: ["mongosh", "--eval", "db.adminCommand('ping')"],
              },
              initialDelaySeconds: 30,
              periodSeconds: 10,
            },
            readinessProbe: {
              exec: {
                command: ["mongosh", "--eval", "db.adminCommand('ping')"],
              },
              initialDelaySeconds: 5,
              periodSeconds: 5,
            },
          },
          {
            name: "mongodb-exporter",
            image: "percona/mongodb_exporter:0.43",
            ports: [{
              containerPort: 9216,
              name: "metrics",
            }],
            command: [
              "/mongodb_exporter",
              pulumi.interpolate`--mongodb.uri=mongodb://root:${mongodbSecret.stringData.rootPassword}@localhost:27017`,
            ],
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
            claimName: "mongodb-data",
          },
        }],
      },
    },
  },
}, { dependsOn: mongodbPVC });

// MongoDB Service
const mongodbService = new k8s.core.v1.Service("mongodb-service", {
  metadata: {
    name: "mongodb",
    namespace: postgresqlNamespace,
    labels: {
      app: "mongodb",
    },
  },
  spec: {
    type: "ClusterIP",
    selector: {
      app: "mongodb",
    },
    ports: [{
      port: 27017,
      targetPort: 27017,
      name: "mongodb",
    }],
  },
});

// Export connection info for applications
export const mongodbHost = pulumi.interpolate`${mongodbService.metadata.name}.${postgresqlNamespace}.svc.cluster.local`;
export const mongodbPort = 27017;
export const mongodbRootPasswordValue = mongodbSecret.stringData.rootPassword;

// Instructions for applications:
//
// Connect to MongoDB using:
//   Host: mongodb.database.svc.cluster.local
//   Port: 27017
//   Root Username: root
//   Root Password: <from secret mongodb-credentials>
//
// Applications should create their own databases and users via init scripts
// or manual setup. Example for UniFi:
//   1. Connect as root
//   2. Create unifi database
//   3. Create unifi user with dbOwner role
//   4. Create unifi_stat database for statistics
//
// Data stored at: /mnt/k8s-fast/local-path-provisioner (backed by sanoid/syncoid)
//
// MongoDB configuration:
//   - Version 8.0 (latest stable)
//   - 20Gi persistent storage on local-path (ZFS-backed)
//   - Prometheus metrics via mongodb_exporter sidecar on port 9216
//   - Authentication enabled
//   - Single replica (can scale to replica set later)