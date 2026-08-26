// ntfy - Simple notification service for mobile/desktop
// Self-hosted push notification server
// Accessible via ntfy.mvissing.de

import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import { namespaceName } from "./namespace";
import { onNode, MAXDATA } from "../infrastructure/sites";

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
#
# WARNING: 'info', not 'trace'. At trace level ntfy logs the full HTTP request
# including the Authorization: Basic <base64> header of every publish -- the
# alertmanager topic credential, in recoverable form. Alloy ships this
# namespace's pod logs to Loki, so it did not stay in the pod either.
#
# Trace was presumably set while debugging the publish failures recorded above,
# where it was genuinely useful. It is not something to leave on.
#
# WARNING: logs already written still contain the credential. Rotating it means
# tainting the ntfy-alertmanager-password RandomPassword and letting Grafana and
# the init container below pick the new value up.
log-level: info
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

// The topic Alertmanager publishes to, and the user it authenticates as.
//
// ⚠️ These two constants are the whole reason alerting worked at all. ntfy runs
// `auth-default-access: deny-all` (above) and, until this existed, had **no
// users whatsoever** — only the implicit anonymous `*`. Every publish was
// therefore rejected, so Prometheus' alert rules fired into nothing and the
// setup looked complete from every side: rules loaded, Alertmanager healthy,
// ntfy healthy, no errors anywhere.
//
// ⚠️ `deny-all` is load-bearing rather than cautious, because this server's
// Ingress carries **no Authentik middleware** (see below) — it answers to
// anything on the LAN. Do not "fix" a publish failure by granting `everyone`
// write access to the topic; grant it to a named user, as here.
export const ntfyAlertTopic = "alerts";
const ntfyAlertUser = "alertmanager";

// `special: false` deliberately: this travels as an HTTP basic-auth credential
// and through a shell in the init container below, and buys nothing over the
// extra length.
const ntfyAlertPassword = new random.RandomPassword(
  "ntfy-alertmanager-password",
  {
    length: 40,
    special: false,
  },
);

// Consumed by Alertmanager in `monitoring/prometheus.ts`, mounted as a *file*
// rather than inlined — the alertmanager subchart renders its config into a
// plain ConfigMap, so an inline password would be readable by anything with
// ConfigMap access in this namespace.
// Also consumed by Grafana's unified alerting (`monitoring/grafana.ts`), which
// needs the value rather than a file: the Grafana chart's `envRenderSecret`
// renders it into a Secret of its own, so it still never reaches a ConfigMap.
export const ntfyAlertUsername = ntfyAlertUser;
export const ntfyAlertPasswordValue = ntfyAlertPassword.result;

export const ntfyAlertCredentials = new k8s.core.v1.Secret(
  "ntfy-alertmanager-credentials",
  {
    metadata: {
      name: "ntfy-alertmanager-credentials",
      namespace: namespaceName,
    },
    stringData: {
      username: ntfyAlertUser,
      password: ntfyAlertPassword.result,
    },
  },
);

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
        // Pinned to maxdata: local-path cache/attachment volume (D6).
        nodeSelector: onNode(MAXDATA),
        // Create the publishing user before the server starts.
        //
        // Same shape as Mosquitto's `init-passwd` container, and for the same
        // reason: the alternative is a `kubectl exec` documented in a comment,
        // which is exactly the kind of step that is never run — as the total
        // absence of ntfy users proved.
        //
        // ⚠️ All three commands are idempotent *by construction*, because this
        // runs on every pod start. `--ignore-exists` alone would leave the
        // password to drift out of sync with the Secret after the first
        // creation, so `change-pass` re-asserts it and `access` re-asserts the
        // ACL. The CLI finds `auth-file` via `/etc/ntfy/server.yml`, which is
        // why the config volume is mounted here and not just the cache.
        initContainers: [
          {
            name: "init-users",
            image: "binwiederhier/ntfy:v2.27.0",
            command: ["/bin/sh", "-c"],
            args: [
              [
                "set -e",
                `ntfy user add --ignore-exists --role=user ${ntfyAlertUser}`,
                `ntfy user change-pass ${ntfyAlertUser}`,
                `ntfy access ${ntfyAlertUser} ${ntfyAlertTopic} write-only`,
              ].join("\n"),
            ],
            env: [
              {
                name: "NTFY_PASSWORD",
                valueFrom: {
                  secretKeyRef: {
                    name: ntfyAlertCredentials.metadata.name,
                    key: "password",
                  },
                },
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
          },
        ],
        containers: [
          {
            name: "ntfy",
            image: "binwiederhier/ntfy:v2.27.0",
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
      "cert-manager.io/cluster-issuer": activeClusterIssuer,
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
