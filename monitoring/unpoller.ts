// UnPoller - UniFi Poller for Prometheus
// Collects metrics from UniFi Network Controller and exports to Prometheus
// Provides detailed network statistics, device metrics, and client information

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { namespaceName } from "./namespace";

// Get UniFi credentials from Pulumi config
const config = new pulumi.Config();
// UniFi OS Server serves its API on :443 (the old Network Application used
// :8443). Override via the `unpoller-url` config if you front it differently.
const unifiUrl =
  config.get("unpoller-url") || "https://unifi.unifi.svc.cluster.local";
// ⚠️ API key, not user/pass — found 2026-09-15. The UOS Server migration
// (apps/unifi.ts) never migrated the poller user, and the classic
// /api/auth/login the poller uses is what UOS rate-limits: two pods' retry
// storms tripped AUTHENTICATION_FAILED_LIMIT_REACHED and both pods were
// locked out of a controller that looked healthy from the Deployment's
// 1/1. An API key is exclusive of user/pass auth and does not cross the
// login rate-limiter at all. The `unpoller-user` / `unpoller-password`
// config and the unpoller-credentials secret are kept (harmless, and the
// fallback path if a future controller swap needs it) but no longer wired
// into the deployment env.
const unifiApiKey = config.requireSecret("unpoller-api-key");

// Secret for UnPoller credentials
const unpollerApiKeySecret = new k8s.core.v1.Secret("unpoller-api-key", {
  metadata: {
    name: "unpoller-api-key",
    namespace: namespaceName,
  },
  type: "Opaque",
  stringData: {
    api_key: unifiApiKey,
  },
});

// UnPoller Deployment
const unpollerDeployment = new k8s.apps.v1.Deployment("unpoller", {
  metadata: {
    name: "unpoller",
    namespace: namespaceName,
    labels: {
      app: "unpoller",
    },
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        app: "unpoller",
      },
    },
    template: {
      metadata: {
        labels: {
          app: "unpoller",
        },
        annotations: {
          // Prometheus scrape annotations
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9130",
          "prometheus.io/path": "/metrics",
        },
      },
      spec: {
        containers: [
          {
            name: "unpoller",
            image: "golift/unifi-poller:v5.2.8",
            ports: [
              {
                containerPort: 9130,
                name: "metrics",
                protocol: "TCP",
              },
            ],
            env: [
              {
                name: "UP_UNIFI_DEFAULT_URL",
                value: unifiUrl,
              },
              {
                // Exclusive of user/pass: with an API key set, unpoller signs
                // every request directly and never touches /api/auth/login —
                // the endpoint UOS rate-limits (see the comment above).
                name: "UP_UNIFI_DEFAULT_API_KEY",
                valueFrom: {
                  secretKeyRef: {
                    name: unpollerApiKeySecret.metadata.name,
                    key: "api_key",
                  },
                },
              },
              {
                name: "UP_UNIFI_DEFAULT_VERIFY_SSL",
                value: "false",
              },
              {
                name: "UP_PROMETHEUS_NAMESPACE",
                value: "unpoller",
              },
              {
                name: "UP_PROMETHEUS_HTTP_LISTEN",
                value: "0.0.0.0:9130",
              },
              {
                name: "UP_INFLUXDB_DISABLE",
                value: "true",
              },
            ],
            resources: {
              requests: {
                memory: "128Mi",
                cpu: "50m",
              },
              limits: {
                memory: "256Mi",
                cpu: "200m",
              },
            },
            livenessProbe: {
              httpGet: {
                path: "/metrics",
                port: 9130,
              },
              initialDelaySeconds: 30,
              periodSeconds: 30,
            },
            readinessProbe: {
              httpGet: {
                path: "/metrics",
                port: 9130,
              },
              initialDelaySeconds: 10,
              periodSeconds: 10,
            },
          },
        ],
      },
    },
  },
});

// Service for UnPoller metrics
const unpollerService = new k8s.core.v1.Service("unpoller-service", {
  metadata: {
    name: "unpoller",
    namespace: namespaceName,
    labels: {
      app: "unpoller",
    },
  },
  spec: {
    type: "ClusterIP",
    selector: {
      app: "unpoller",
    },
    ports: [
      {
        name: "metrics",
        port: 9130,
        targetPort: 9130,
        protocol: "TCP",
      },
    ],
  },
});

export { unpollerDeployment, unpollerService };

// Setup Instructions:
//
// 1. Create a local user in UniFi Controller:
//    - Create an API key in the Network application UI (Settings → Control
//      Plane → API, or your admin profile → API Keys, depending on version).
//      An API key is exclusive of user/pass and never crosses the /api/auth
//      login endpoint that UOS rate-limits (AUTHENTICATION_FAILED_LIMIT_
//      REACHED locked both pods out during the 2026-09-13..15 outage).
//
// 2. Add the API key to Pulumi config:
//    pulumi config set --secret unpoller-api-key <key-from-step-1>
//
// 3. (Optional) Override default settings:
//    pulumi config set unpoller-url https://unifi.unifi.svc.cluster.local
//
//    Legacy user/pass auth (`unpoller-user` / `unpoller-password` config and
//    the unpoller-credentials secret) is no longer wired into the deployment
//    env, but the config keys are harmless to keep as a fallback.
//
// 4. Update monitoring/index.ts to export UnPoller:
//    Add: export * from "./unpoller";
//
// 5. Deploy UnPoller:
//    pulumi up
//
// 6. Verify deployment:
//    kubectl get pods -n monitoring -l app=unpoller
//    kubectl logs -n monitoring -l app=unpoller
//
// 7. Check metrics in Prometheus:
//    - Go to https://prometheus.mvissing.de
//    - Status → Targets → Look for "kubernetes-pods" with unpoller
//    - Graph → Query: unpoller_device_info
//
// 8. Import UniFi Grafana dashboards:
//    - Go to https://grafana.mvissing.de
//    - Dashboards → Import
//    - Use dashboard ID: 11315 (UniFi-Poller: Client Insights - Prometheus)
//    - Use dashboard ID: 11311 (UniFi-Poller: Network Sites - Prometheus)
//    - Use dashboard ID: 11314 (UniFi-Poller: USW Insights - Prometheus)
//    - Use dashboard ID: 11312 (UniFi-Poller: UAP Insights - Prometheus)
//    - Use dashboard ID: 11313 (UniFi-Poller: USG Insights - Prometheus)
//
// Metrics collected:
//   - Device metrics: Status, uptime, CPU, memory, temperature
//   - Network metrics: Bytes transferred, packet rates, errors
//   - Client metrics: Connected clients, traffic per client
//   - Site metrics: Overall network statistics
//   - Port metrics: Switch port statistics
//   - Wireless metrics: SSID stats, channel utilization
//
// Troubleshooting:
//   - Check pod logs: kubectl logs -n monitoring -l app=unpoller
//   - Verify UniFi user has "Read Only" role
//   - Check network connectivity: kubectl exec -n monitoring <unpoller-pod> -- wget -O- https://unifi.unifi.svc.cluster.local:8443
//   - Verify SSL setting: UnPoller is configured with verify_ssl: false for self-signed certs
//
// Popular Grafana Dashboards for UniFi:
//   11315: Client Insights - Detailed client connection info
//   11311: Network Sites - Overall network overview
//   11314: USW Insights - UniFi Switch metrics
//   11312: UAP Insights - UniFi Access Point metrics
//   11313: USG Insights - UniFi Gateway metrics
