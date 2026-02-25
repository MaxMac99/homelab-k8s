// Home Assistant - Home Automation Platform
// Uses shared PostgreSQL database for recorder
// Configuration stored on NFS (tank pool)
// Integrates with Authentik for OAuth2/OIDC SSO

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Import shared service connection info
import {
  postgresqlHost,
  postgresqlNamespace,
  postgresqlClusterName,
  homeassistantDbPassword,
} from "./postgresql";

// Create namespace for Home Assistant
const namespace = new k8s.core.v1.Namespace("homeassistant", {
  metadata: {
    name: "homeassistant",
  },
});

// Create PostgreSQL credentials secret directly in homeassistant namespace
// (Not relying on Reflector due to reliability issues)
const homeassistantDbSecret = new k8s.core.v1.Secret(
  "homeassistant-db-secret",
  {
    metadata: {
      name: "postgres-homeassistant",
      namespace: namespace.metadata.name,
    },
    type: "kubernetes.io/basic-auth",
    stringData: {
      username: "homeassistant",
      password: homeassistantDbPassword,
    },
  },
);

// Declaratively create Home Assistant database using CloudNativePG
const homeassistantDatabase = new k8s.apiextensions.CustomResource(
  "homeassistant-database",
  {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Database",
    metadata: {
      name: "homeassistant-db",
      namespace: postgresqlNamespace,
    },
    spec: {
      name: "homeassistant",
      owner: "homeassistant",
      cluster: {
        name: postgresqlClusterName,
      },
    },
  },
);

// NFS Persistent Volume for configuration storage (on tank pool)
const homeassistantConfigPV = new k8s.core.v1.PersistentVolume(
  "homeassistant-config-pv",
  {
    metadata: {
      name: "homeassistant-config",
    },
    spec: {
      capacity: {
        storage: "10Gi",
      },
      accessModes: ["ReadWriteMany"],
      persistentVolumeReclaimPolicy: "Retain",
      storageClassName: "nfs",
      mountOptions: ["nfsvers=4.2", "hard", "intr"],
      nfs: {
        server: "192.168.178.2", // maxdata NFS server
        path: "/tank/k8s/nfs/homeassistant",
      },
    },
  },
);

// NFS Persistent Volume for Matter Server data
const matterServerDataPV = new k8s.core.v1.PersistentVolume(
  "matter-server-data-pv",
  {
    metadata: {
      name: "matter-server-data",
    },
    spec: {
      capacity: {
        storage: "1Gi",
      },
      accessModes: ["ReadWriteMany"],
      persistentVolumeReclaimPolicy: "Retain",
      storageClassName: "nfs",
      mountOptions: ["nfsvers=4.2", "hard", "intr"],
      nfs: {
        server: "192.168.178.2", // maxdata NFS server
        path: "/tank/k8s/nfs/matter-server",
      },
    },
  },
);

// PVC for NFS config storage
const homeassistantConfigPVC = new k8s.core.v1.PersistentVolumeClaim(
  "homeassistant-config-pvc",
  {
    metadata: {
      name: "homeassistant-config",
      namespace: namespace.metadata.name,
    },
    spec: {
      accessModes: ["ReadWriteMany"],
      storageClassName: "nfs",
      volumeName: homeassistantConfigPV.metadata.name,
      resources: {
        requests: {
          storage: "10Gi",
        },
      },
    },
  },
);

// PVC for Matter Server data
const matterServerDataPVC = new k8s.core.v1.PersistentVolumeClaim(
  "matter-server-data-pvc",
  {
    metadata: {
      name: "matter-server-data",
      namespace: namespace.metadata.name,
    },
    spec: {
      accessModes: ["ReadWriteMany"],
      storageClassName: "nfs",
      volumeName: matterServerDataPV.metadata.name,
      resources: {
        requests: {
          storage: "1Gi",
        },
      },
    },
  },
);

// Home Assistant Deployment
const homeassistantDeployment = new k8s.apps.v1.Deployment(
  "homeassistant",
  {
    metadata: {
      name: "homeassistant",
      namespace: namespace.metadata.name,
      labels: {
        app: "homeassistant",
      },
    },
    spec: {
      replicas: 1,
      strategy: {
        type: "Recreate", // Important: HA can't run multiple instances
      },
      selector: {
        matchLabels: {
          app: "homeassistant",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "homeassistant",
          },
        },
        spec: {
          // Use host network for full mDNS/Bonjour discovery support
          hostNetwork: true,
          dnsPolicy: "ClusterFirstWithHostNet",
          containers: [
            {
              name: "homeassistant",
              image: "ghcr.io/home-assistant/home-assistant:2025.12",
              ports: [
                {
                  containerPort: 8123,
                  name: "http",
                  protocol: "TCP",
                },
              ],
              env: [
                {
                  name: "TZ",
                  value: "Europe/Berlin",
                },
              ],
              volumeMounts: [
                {
                  name: "config",
                  mountPath: "/config",
                },
              ],
              resources: {
                requests: {
                  memory: "512Mi",
                  cpu: "500m",
                },
                limits: {
                  memory: "2Gi",
                  cpu: "2000m",
                },
              },
              livenessProbe: {
                httpGet: {
                  path: "/",
                  port: 8123,
                },
                initialDelaySeconds: 60,
                periodSeconds: 30,
                timeoutSeconds: 5,
              },
              readinessProbe: {
                httpGet: {
                  path: "/",
                  port: 8123,
                },
                initialDelaySeconds: 30,
                periodSeconds: 10,
                timeoutSeconds: 5,
              },
            },
          ],
          volumes: [
            {
              name: "config",
              persistentVolumeClaim: {
                claimName: homeassistantConfigPVC.metadata.name,
              },
            },
          ],
        },
      },
    },
  },
  { dependsOn: [homeassistantDatabase, homeassistantConfigPVC] },
);

// Matter Server Deployment
// Provides Matter protocol support for Home Assistant
const matterServerDeployment = new k8s.apps.v1.Deployment(
  "matter-server",
  {
    metadata: {
      name: "matter-server",
      namespace: namespace.metadata.name,
      labels: {
        app: "matter-server",
      },
    },
    spec: {
      replicas: 1,
      strategy: {
        type: "Recreate", // Matter Server should not run multiple instances
      },
      selector: {
        matchLabels: {
          app: "matter-server",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "matter-server",
          },
        },
        spec: {
          // Use host network for mDNS/Thread discovery
          hostNetwork: true,
          dnsPolicy: "ClusterFirstWithHostNet",
          containers: [
            {
              name: "matter-server",
              image: "ghcr.io/matter-js/python-matter-server:8.1.1",
              args: ["--storage-path", "/data", "--log-level", "info"],
              ports: [
                {
                  containerPort: 5580,
                  name: "websocket",
                  protocol: "TCP",
                },
              ],
              env: [
                {
                  name: "TZ",
                  value: "Europe/Berlin",
                },
              ],
              volumeMounts: [
                {
                  name: "data",
                  mountPath: "/data",
                },
              ],
              resources: {
                requests: {
                  memory: "256Mi",
                  cpu: "100m",
                },
                limits: {
                  memory: "512Mi",
                  cpu: "500m",
                },
              },
              livenessProbe: {
                tcpSocket: {
                  port: 5580,
                },
                initialDelaySeconds: 30,
                periodSeconds: 30,
                timeoutSeconds: 5,
              },
              readinessProbe: {
                tcpSocket: {
                  port: 5580,
                },
                initialDelaySeconds: 10,
                periodSeconds: 10,
                timeoutSeconds: 5,
              },
            },
          ],
          volumes: [
            {
              name: "data",
              persistentVolumeClaim: {
                claimName: matterServerDataPVC.metadata.name,
              },
            },
          ],
        },
      },
    },
  },
  { dependsOn: [matterServerDataPVC] },
);

// Matter Server Service
const matterServerService = new k8s.core.v1.Service("matter-server-service", {
  metadata: {
    name: "matter-server",
    namespace: namespace.metadata.name,
  },
  spec: {
    type: "ClusterIP",
    selector: {
      app: "matter-server",
    },
    ports: [
      {
        port: 5580,
        targetPort: 5580,
        name: "websocket",
        protocol: "TCP",
      },
    ],
  },
});

// Home Assistant Service - ClusterIP (hostNetwork handles direct LAN access)
const homeassistantService = new k8s.core.v1.Service("homeassistant-service", {
  metadata: {
    name: "homeassistant",
    namespace: namespace.metadata.name,
  },
  spec: {
    type: "ClusterIP",
    selector: {
      app: "homeassistant",
    },
    ports: [
      {
        port: 80,
        targetPort: 8123,
        name: "http",
        protocol: "TCP",
      },
    ],
  },
});

// Ingress for Home Assistant
const homeassistantIngress = new k8s.networking.v1.Ingress(
  "homeassistant-ingress",
  {
    metadata: {
      name: "homeassistant",
      namespace: namespace.metadata.name,
      annotations: {
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
        "cert-manager.io/cluster-issuer": "letsencrypt-prod",

        // Redirect HTTP to HTTPS
        "traefik.ingress.kubernetes.io/redirect-entry-point": "websecure",
        "traefik.ingress.kubernetes.io/redirect-permanent": "true",

        // Homepage dashboard discovery
        "gethomepage.dev/enabled": "true",
        "gethomepage.dev/name": "Home Assistant",
        "gethomepage.dev/description": "Home Automation",
        "gethomepage.dev/group": "Home",
        "gethomepage.dev/icon": "home-assistant",
        "gethomepage.dev/pod-selector": "app=homeassistant",
        "gethomepage.dev/href": "https://home.mvissing.de/auth/oidc/redirect",
      },
    },
    spec: {
      ingressClassName: "traefik",
      rules: [
        {
          host: "home.mvissing.de",
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: homeassistantService.metadata.name,
                    port: {
                      number: 80,
                    },
                  },
                },
              },
            ],
          },
        },
      ],
      tls: [
        {
          secretName: "homeassistant-tls",
          hosts: ["home.mvissing.de"],
        },
      ],
    },
  },
);

export {
  namespace as homeassistantNamespace,
  homeassistantDeployment,
  homeassistantService,
  homeassistantIngress,
};

// Setup Instructions:
//
// 1. Extract configuration from QCOW2 backup (on maxdata host):
//    # Mount qcow2 image
//    sudo modprobe nbd max_part=8
//    sudo qemu-nbd -c /dev/nbd0 ~/homeassistant/haos_ova-13.2.qcow2
//    sudo mkdir -p /mnt/hass-backup
//    sudo mount /dev/nbd0p2 /mnt/hass-backup
//
//    # Extract configuration
//    sudo mkdir -p /tank/k8s/nfs/homeassistant
//    sudo cp -a /mnt/hass-backup/config/* /tank/k8s/nfs/homeassistant/
//    sudo chown -R 1000:1000 /tank/k8s/nfs/homeassistant
//
//    # Cleanup
//    sudo umount /mnt/hass-backup
//    sudo qemu-nbd -d /dev/nbd0
//
// 2. Update configuration.yaml for Kubernetes:
//    # Add PostgreSQL recorder
//    recorder:
//      db_url: postgresql://homeassistant:PASSWORD@postgres-rw.database.svc.cluster.local:5432/homeassistant
//      purge_keep_days: 30
//      commit_interval: 1
//      auto_purge: true
//
//    # Add trusted proxies for Traefik
//    http:
//      use_x_forwarded_for: true
//      trusted_proxies:
//        - 10.0.0.0/8      # K8s pod network
//        - 172.16.0.0/12   # Docker network
//        - 192.168.0.0/16  # Local network
//      ip_ban_enabled: false  # Let Authentik handle security
//
//    # Add Prometheus metrics
//    prometheus:
//      namespace: homeassistant
//
//    # Remove or comment out any SQLite db_url references
//
// 3. Configure Authentik OAuth2/OIDC Provider:
//    a. Go to Authentik UI (https://auth.mvissing.de)
//    b. Create new OAuth2/OpenID Provider:
//       - Name: Home Assistant
//       - Client type: Confidential
//       - Redirect URIs: https://home.mvissing.de/auth/external/callback
//       - Scopes: openid profile email
//    c. Create new Application:
//       - Name: Home Assistant
//       - Slug: homeassistant
//       - Provider: (select provider from step b)
//    d. Note the Client ID and Client Secret
//
// 4. Deploy with: pulumi up
//
// 5. Access Home Assistant at: https://home.mvissing.de
//
// 6. Install HACS (Home Assistant Community Store):
//    - Follow: https://hacs.xyz/docs/setup/download
//
// 7. Install OIDC authentication via HACS:
//    - HACS → Integrations → Explore & Download Repositories
//    - Search: "OIDC Authentication" or "OpenID Connect"
//    - Download and restart Home Assistant
//
// 8. Configure OIDC integration:
//    - Settings → Devices & Services → Add Integration
//    - Search: "OIDC"
//    - Issuer URL: https://auth.mvissing.de/application/o/homeassistant/
//    - Client ID: (from Authentik)
//    - Client Secret: (from Authentik)
//
// Architecture:
// - Home Assistant: Official container image
// - Matter Server: Python Matter Server for Matter protocol support
// - PostgreSQL: Shared database cluster (CloudNativePG)
// - Storage: NFS on tank pool for configuration (10Gi) and Matter data (1Gi)
// - Ingress: Traefik with Let's Encrypt TLS
// - Authentication: OAuth2/OIDC via Authentik (using custom component)
// - Monitoring: Prometheus metrics at /api/prometheus
//
// Storage:
// - Config: /tank/k8s/nfs/homeassistant (NFS, 10Gi)
// - Matter Server: /tank/k8s/nfs/matter-server (NFS, 1Gi)
// - Database: PostgreSQL cluster in database namespace
// - Backup: ZFS snapshots via sanoid/syncoid
//
// Important Notes:
// - Home Assistant MUST run as single replica (no multi-instance support)
// - Do NOT use Authentik forward auth middleware on ingress (breaks OAuth2 flow)
// - HA handles its own authentication via OIDC
// - Prometheus metrics exposed at :8123/api/prometheus (requires long-lived token)
//
// Add-ons:
// - Container mode does NOT support Home Assistant Add-on Store
// - Deploy add-ons as separate K8s deployments (MQTT, Zigbee2MQTT, Node-RED, etc.)
// - See plan documentation for USB device passthrough options
//
// Matter Server Setup:
// 1. Create Matter Server data directory on NFS server:
//    sudo mkdir -p /tank/k8s/nfs/matter-server
//    sudo chown -R 1000:1000 /tank/k8s/nfs/matter-server
//
// 2. Deploy Matter Server: pulumi up
//
// 3. Add Matter integration in Home Assistant:
//    - Settings → Devices & Services → Add Integration
//    - Search: "Matter (BETA)"
//    - Select "Matter (BETA)"
//    - URL: ws://matter-server.homeassistant.svc.cluster.local:5580/ws
//    - Or use the hostname directly: ws://matter-server:5580/ws
//
// 4. Commission Matter devices:
//    - Settings → Devices & Services → Matter → Add Device
//    - Scan the QR code or enter the setup code from your Matter device
//    - Device will be commissioned and added to Home Assistant
//
// Notes:
// - Matter Server uses hostNetwork for mDNS/Thread discovery
// - WebSocket API on port 5580 for Home Assistant communication
// - Data stored on NFS at /tank/k8s/nfs/matter-server
// - Matter devices remain commissioned even if HA restarts
