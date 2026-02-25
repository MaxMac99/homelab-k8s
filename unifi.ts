// UniFi Network Controller - Network Management System
// Uses shared MongoDB database for storing network data
// Deployed with LinuxServer.io UniFi Network Application
//
// Migration Notes:
// - Initially deployed with version 8.0.7 (matching Pi version)
// - Upgrade to latest after successful restore
// - Update image version in deployment and run pulumi up

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

// Import shared MongoDB connection info
import { mongodbHost, mongodbRootPasswordValue } from "./mongodb";

// Create namespace for UniFi
const namespace = new k8s.core.v1.Namespace("unifi", {
  metadata: {
    name: "unifi",
  },
});

// Generate password for UniFi's MongoDB user
const unifiMongoPassword = new random.RandomPassword("unifi-mongo-password", {
  length: 32,
  special: false,
});

// Secret for UniFi MongoDB credentials
const unifiMongoSecret = new k8s.core.v1.Secret("unifi-mongo-secret", {
  metadata: {
    name: "unifi-mongo-credentials",
    namespace: namespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    username: "unifi",
    password: unifiMongoPassword.result,
  },
});

// MongoDB initialization job - creates UniFi databases and user
// Runs once on deployment to set up UniFi-specific databases
const mongoInitJob = new k8s.batch.v1.Job("unifi-mongo-init", {
  metadata: {
    name: "unifi-mongo-init",
    namespace: namespace.metadata.name,
  },
  spec: {
    template: {
      spec: {
        restartPolicy: "OnFailure",
        containers: [{
          name: "mongo-init",
          image: "mongo:8.0",
          command: ["mongosh"],
          args: [
            pulumi.interpolate`mongodb://root:${mongodbRootPasswordValue}@${mongodbHost}:27017/admin`,
            "--eval",
            pulumi.interpolate`
db = db.getSiblingDB('unifi');
try {
  db.createUser({
    user: '${unifiMongoSecret.stringData.username}',
    pwd: '${unifiMongoSecret.stringData.password}',
    roles: [
      { role: 'dbOwner', db: 'unifi' },
      { role: 'dbOwner', db: 'unifi_stat' }
    ]
  });
  print('Created user in unifi database with access to both unifi and unifi_stat');
} catch (e) {
  if (e.code === 51003) {
    print('User already exists');
  } else {
    throw e;
  }
}
`,
          ],
        }],
      },
    },
  },
});

// PVC for UniFi application data
const unifiDataPVC = new k8s.core.v1.PersistentVolumeClaim("unifi-data-pvc", {
  metadata: {
    name: "unifi-data",
    namespace: namespace.metadata.name,
  },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "local-path",
    resources: {
      requests: {
        storage: "5Gi",
      },
    },
  },
});

// UniFi Network Application Deployment
const unifiDeployment = new k8s.apps.v1.Deployment("unifi", {
  metadata: {
    name: "unifi",
    namespace: namespace.metadata.name,
    labels: {
      app: "unifi",
    },
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        app: "unifi",
      },
    },
    template: {
      metadata: {
        labels: {
          app: "unifi",
        },
      },
      spec: {
        nodeSelector: {
          "kubernetes.io/arch": "amd64",
        },
        containers: [{
          name: "unifi",
          image: "lscr.io/linuxserver/unifi-network-application:10.0.160",
          ports: [
            {
              containerPort: 8443,
              name: "https",
              protocol: "TCP",
            },
            {
              containerPort: 8080,
              name: "inform",
              protocol: "TCP",
            },
            {
              containerPort: 3478,
              name: "stun",
              protocol: "UDP",
            },
            {
              containerPort: 10001,
              name: "discovery",
              protocol: "UDP",
            },
            {
              containerPort: 6789,
              name: "speedtest",
              protocol: "TCP",
            },
          ],
          env: [
            {
              name: "MONGO_HOST",
              value: mongodbHost,
            },
            {
              name: "MONGO_PORT",
              value: "27017",
            },
            {
              name: "MONGO_DBNAME",
              value: "unifi",
            },
            {
              name: "MONGO_USER",
              valueFrom: {
                secretKeyRef: {
                  name: unifiMongoSecret.metadata.name,
                  key: "username",
                },
              },
            },
            {
              name: "MONGO_PASS",
              valueFrom: {
                secretKeyRef: {
                  name: unifiMongoSecret.metadata.name,
                  key: "password",
                },
              },
            },
            {
              name: "MONGO_AUTHSOURCE",
              value: "unifi",
            },
            {
              name: "TZ",
              value: "Europe/Berlin",
            },
            {
              name: "MEM_LIMIT",
              value: "1024",
            },
            {
              name: "MEM_STARTUP",
              value: "1024",
            },
          ],
          volumeMounts: [{
            name: "data",
            mountPath: "/config",
          }],
          resources: {
            requests: {
              memory: "1Gi",
              cpu: "500m",
            },
            limits: {
              memory: "3Gi",
              cpu: "2000m",
            },
          },
          livenessProbe: {
            tcpSocket: {
              port: 8443,
            },
            initialDelaySeconds: 120,
            periodSeconds: 30,
          },
          readinessProbe: {
            tcpSocket: {
              port: 8443,
            },
            initialDelaySeconds: 90,
            periodSeconds: 10,
          },
        }],
        volumes: [{
          name: "data",
          persistentVolumeClaim: {
            claimName: unifiDataPVC.metadata.name,
          },
        }],
      },
    },
  },
}, { dependsOn: [unifiDataPVC, mongoInitJob] });

// UniFi LoadBalancer Service
const unifiService = new k8s.core.v1.Service("unifi-service", {
  metadata: {
    name: "unifi",
    namespace: namespace.metadata.name,
  },
  spec: {
    type: "LoadBalancer",
    selector: {
      app: "unifi",
    },
    sessionAffinity: "ClientIP",
    ports: [
      {
        name: "https",
        port: 8443,
        targetPort: 8443,
        protocol: "TCP",
      },
      {
        name: "inform",
        port: 8080,
        targetPort: 8080,
        protocol: "TCP",
      },
      {
        name: "stun",
        port: 3478,
        targetPort: 3478,
        protocol: "UDP",
      },
      {
        name: "discovery",
        port: 10001,
        targetPort: 10001,
        protocol: "UDP",
      },
      {
        name: "speedtest",
        port: 6789,
        targetPort: 6789,
        protocol: "TCP",
      },
    ],
  },
});

export {
  namespace as unifiNamespace,
  unifiDeployment,
  unifiService,
};

// Setup Instructions:
//
// 1. Deploy initial infrastructure:
//    cd ~/Git/setup/pulumi/k8s
//    pulumi up
//
// 2. Verify deployment:
//    kubectl get pods -n unifi
//    kubectl get pods -n database  # Check MongoDB
//    kubectl get svc -n unifi  # Note the EXTERNAL-IP assigned by MetalLB
//    kubectl logs -n unifi -l app=unifi
//
// 3. Access UniFi Controller:
//    https://<EXTERNAL-IP>:8443
//    (Get EXTERNAL-IP from: kubectl get svc -n unifi)
//
// 4. Restore backup from Pi:
//    - Via Web UI: Setup Wizard → Restore from Backup → Upload .unf file
//    - Wait for restore to complete (5-10 minutes)
//
// 5. Set inform URL for devices:
//    Settings → System → Advanced → Override Inform Host
//    Set to: http://<EXTERNAL-IP>:8080/inform
//    (Use the IP from kubectl get svc -n unifi)
//
// 6. Adopt devices:
//    Devices → Pending Adoption → Adopt All
//
// 7. Upgrade to latest version (after successful restore):
//    - Edit this file: Change image version from 8.0.7 to latest
//    - Run: pulumi up
//    - Monitor: kubectl logs -n unifi -l app=unifi -f
//    - Wait 5-10 minutes for automatic database migration
//
// Architecture:
// - MongoDB 8.0: Shared instance in database namespace (mongodb.ts)
// - UniFi 8.0.7: Initial deployment (upgrade to latest post-restore)
// - LoadBalancer: MetalLB auto-assigns IP from pool (192.168.178.10-20)
// - Storage: local-path (ZFS-backed) for UniFi config
// - Node Affinity: amd64 nodes (can change to Pi hostname later)
//
// Storage:
// - UniFi config: /config (5Gi PVC on local-path)
// - MongoDB data: Managed in mongodb.ts (20Gi in database namespace)
// - Backup: ZFS snapshots via sanoid/syncoid
//
// Ports:
// - 8443/TCP: Web UI (HTTPS)
// - 8080/TCP: Device inform (required for adoption)
// - 3478/UDP: STUN service (required)
// - 10001/UDP: Device discovery (required)
// - 6789/TCP: Mobile speed test
//
// Remote Access:
// - Continue using ui.com for remote access
// - Local access via https://<EXTERNAL-IP>:8443 (check: kubectl get svc -n unifi)
//
// Migration to Pi (future):
// 1. Add Pi to k3s cluster
// 2. Update nodeSelector in both mongodb.ts and this file
// 3. Run: pulumi up
// 4. Pods reschedule to Pi, devices reconnect automatically