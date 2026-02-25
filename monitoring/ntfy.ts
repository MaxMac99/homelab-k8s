// ntfy - Simple notification service for mobile/desktop
// Self-hosted push notification server
// Accessible via ntfy.mvissing.de

import * as k8s from "@pulumi/kubernetes";
import { namespaceName } from "./namespace";

// PersistentVolumeClaim for ntfy cache and attachment storage
const ntfyPVC = new k8s.core.v1.PersistentVolumeClaim("ntfy-pvc", {
  metadata: {
    name: "ntfy-storage",
    namespace: namespaceName,
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

// ConfigMap for ntfy server configuration
const ntfyConfig = new k8s.core.v1.ConfigMap("ntfy-config", {
  metadata: {
    name: "ntfy-config",
    namespace: namespaceName,
  },
  data: {
    "server.yml": `
# ntfy server configuration
base-url: "https://ntfy.mvissing.de"

# Cache settings
cache-file: "/var/cache/ntfy/cache.db"
cache-duration: "12h"

# Attachment settings
attachment-cache-dir: "/var/cache/ntfy/attachments"
attachment-total-size-limit: "5G"
attachment-file-size-limit: "15M"
attachment-expiry-duration: "3h"

# Keepalive interval
keepalive-interval: "45s"

# Visitor settings (rate limiting)
visitor-subscription-limit: 30
visitor-request-limit-burst: 60
visitor-request-limit-replenish: "5s"
visitor-message-daily-limit: 0

# Enable web UI
web-root: app

# Logging
log-level: trace
log-format: json

# Behind a proxy
behind-proxy: true

# Authentication - enabled with basic auth
auth-file: "/var/cache/ntfy/auth.db"
auth-default-access: "deny-all"

# iOS instant notifications - use ntfy.sh as upstream
upstream-base-url: "https://ntfy.sh"

enable-metrics: true
metrics-listen-http: ":9090"
`,
  },
});

// Deployment for ntfy
const ntfyDeployment = new k8s.apps.v1.Deployment("ntfy", {
  metadata: {
    name: "ntfy",
    namespace: namespaceName,
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        app: "ntfy",
      },
    },
    template: {
      metadata: {
        labels: {
          app: "ntfy",
        },
        annotations: {
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9090",
          "prometheus.io/path": "/metrics",
        },
      },
      spec: {
        containers: [
          {
            name: "ntfy",
            image: "binwiederhier/ntfy:v2.15.0",
            args: ["serve"],
            ports: [
              {
                name: "http",
                containerPort: 80,
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
                mountPath: "/etc/ntfy",
              },
              {
                name: "cache",
                mountPath: "/var/cache/ntfy",
              },
            ],
            resources: {
              requests: {
                cpu: "50m",
                memory: "64Mi",
              },
              limits: {
                cpu: "200m",
                memory: "128Mi",
              },
            },
            livenessProbe: {
              httpGet: {
                path: "/v1/health",
                port: 80,
              },
              initialDelaySeconds: 10,
              periodSeconds: 30,
            },
            readinessProbe: {
              httpGet: {
                path: "/v1/health",
                port: 80,
              },
              initialDelaySeconds: 5,
              periodSeconds: 10,
            },
          },
        ],
        volumes: [
          {
            name: "config",
            configMap: {
              name: ntfyConfig.metadata.name,
            },
          },
          {
            name: "cache",
            persistentVolumeClaim: {
              claimName: ntfyPVC.metadata.name,
            },
          },
        ],
      },
    },
  },
});

// Service for ntfy
const ntfyService = new k8s.core.v1.Service("ntfy", {
  metadata: {
    name: "ntfy",
    namespace: namespaceName,
  },
  spec: {
    selector: {
      app: "ntfy",
    },
    ports: [
      {
        name: "http",
        port: 80,
        targetPort: 80,
      },
    ],
    type: "ClusterIP",
  },
});

// Ingress for ntfy (Traefik, no Authentik middleware)
const ntfyIngress = new k8s.networking.v1.Ingress("ntfy", {
  metadata: {
    name: "ntfy",
    namespace: namespaceName,
    annotations: {
      "cert-manager.io/cluster-issuer": "letsencrypt-prod",
      // Homepage dashboard discovery
      "gethomepage.dev/enabled": "true",
      "gethomepage.dev/name": "ntfy",
      "gethomepage.dev/description": "Push Notifications",
      "gethomepage.dev/group": "Infrastructure",
      "gethomepage.dev/icon": "ntfy",
      "gethomepage.dev/href": "https://ntfy.mvissing.de",
      "gethomepage.dev/pod-selector": "app=ntfy",
    },
  },
  spec: {
    ingressClassName: "traefik",
    tls: [
      {
        secretName: "ntfy-tls",
        hosts: ["ntfy.mvissing.de"],
      },
    ],
    rules: [
      {
        host: "ntfy.mvissing.de",
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: {
                service: {
                  name: ntfyService.metadata.name,
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
  },
});

// Export the ntfy URL
export const ntfyUrl = "https://ntfy.mvissing.de";
export const ntfyInternalUrl = `http://${ntfyService.metadata.name}.${namespaceName}.svc.cluster.local`;

export { ntfyDeployment, ntfyService, ntfyIngress };

// Usage:
//
// External access: https://ntfy.mvissing.de (with TLS via Traefik)
// Internal (for Grafana): http://ntfy.monitoring.svc.cluster.local
// Web UI enabled with basic authentication
//
// Setup Authentication:
// 1. Create admin user:
//    kubectl exec -it deployment/ntfy -n monitoring -- ntfy user add --role=admin admin
//
// 2. Create a user for yourself:
//    kubectl exec -it deployment/ntfy -n monitoring -- ntfy user add myuser
//
// 3. Grant access to topics:
//    kubectl exec -it deployment/ntfy -n monitoring -- ntfy access admin grafana-alerts write
//    kubectl exec -it deployment/ntfy -n monitoring -- ntfy access myuser grafana-alerts read
//
// iPhone App Setup:
// 1. Install ntfy from App Store
// 2. Add server: https://ntfy.mvissing.de
// 3. Enter username and password
// 4. Subscribe to topic: "grafana-alerts"
//
// Web UI Access:
//   https://ntfy.mvissing.de
//   Login with username and password
//
// Send test notification (with auth):
//   curl -u admin:password -d "Hello from ntfy!" https://ntfy.mvissing.de/grafana-alerts
//
// Grafana Integration:
//   Use webhook contact point with URL:
//   http://ntfy.monitoring.svc.cluster.local/grafana-alerts
//   Add basic auth credentials in Grafana contact point settings