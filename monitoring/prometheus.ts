// Prometheus - Metrics collection and monitoring
// Scrapes metrics from Kubernetes services and applications
// Accessible via prometheus.mvissing.de

import * as k8s from "@pulumi/kubernetes";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import * as pulumi from "@pulumi/pulumi";
import { namespaceName } from "./namespace";
import { onNode, HOSTNAME_LABEL, MAXDATA } from "../infrastructure/sites";
import { ntfyAlertTopic, ntfyAlertCredentials } from "./ntfy";
import { blackboxServiceUrl } from "./blackbox";

// Get Home Assistant Prometheus token from config
const config = new pulumi.Config();
const homeassistantPrometheusToken =
  config.getSecret("homeassistant-prometheus-token") || "";

// Create secret for Home Assistant Prometheus authentication
const homeassistantPrometheusTokenSecret = new k8s.core.v1.Secret(
  "homeassistant-prometheus-token",
  {
    metadata: {
      name: "homeassistant-prometheus-token",
      namespace: namespaceName,
    },
    stringData: {
      token: homeassistantPrometheusToken,
    },
  },
);

// Install Prometheus using Helm chart
const prometheus = new k8s.helm.v3.Chart("prometheus", {
  chart: "prometheus",
  version: "29.21.0",
  namespace: namespaceName,
  fetchOpts: {
    repo: "https://prometheus-community.github.io/helm-charts",
  },
  transformations: [
    (obj: any) => {
      if (obj.kind === "PersistentVolumeClaim") {
        obj.metadata.annotations = obj.metadata.annotations || {};
        obj.metadata.annotations["pulumi.com/skipAwait"] = "true";
      }
    },
  ],
  values: {
    // Prometheus server configuration
    server: {
      // Persistent storage for metrics using local-path (ZFS backed)
      persistentVolume: {
        enabled: true,
        storageClass: "local-path",
        size: "100Gi", // Larger storage for 1 year retention
      },

      // Data retention - keep metrics for 1 year
      retention: "365d",

      // Pinned to maxdata: 100 Gi of local-path with no replica (D6).
      nodeSelector: onNode(MAXDATA),

      // Resource limits
      resources: {
        requests: {
          cpu: "500m",
          memory: "2Gi",
        },
        limits: {
          cpu: "2",
          memory: "4Gi",
        },
      },

      // Ingress for Prometheus UI
      ingress: {
        enabled: true,
        ingressClassName: "traefik", // Changed from traefik-external - now using port forwarding on ionos
        annotations: {
          "cert-manager.io/cluster-issuer": activeClusterIssuer,
          // Protect with Authentik forward auth
          "traefik.ingress.kubernetes.io/router.middlewares":
            "traefik-authentik@kubernetescrd",
          // Homepage dashboard discovery
          "gethomepage.dev/enabled": "true",
          "gethomepage.dev/name": "Prometheus",
          "gethomepage.dev/description": "Metrics & Alerting",
          "gethomepage.dev/group": "Monitoring",
          "gethomepage.dev/icon": "prometheus",
          "gethomepage.dev/pod-selector":
            "app.kubernetes.io/name=prometheus,app.kubernetes.io/component=server",
          "gethomepage.dev/href": "https://prometheus.mvissing.de",
          // Prometheus widget - shows target status
          "gethomepage.dev/widget.type": "prometheus",
          "gethomepage.dev/widget.url":
            "http://prometheus-server.monitoring.svc.cluster.local",
        },
        hosts: ["prometheus.mvissing.de"],
        tls: [
          {
            secretName: "prometheus-tls",
            hosts: ["prometheus.mvissing.de"],
          },
        ],
      },

      // Enable ServiceMonitor for scraping metrics
      service: {
        type: "ClusterIP",
      },

      // Mount secrets for authentication
      extraSecretMounts: [
        {
          name: "homeassistant-prometheus-token",
          mountPath: "/etc/prometheus/secrets/homeassistant-prometheus-token",
          secretName: "homeassistant-prometheus-token",
          readOnly: true,
        },
      ],
    },

    // AlertManager.
    //
    // ⚠️ **Kept deliberately after Phase C, not left behind.** The plan asked
    // whether it should stay once the rules moved to Grafana; it stays, but its
    // job is now exactly one rule — see `alerting-watchdog` in serverFiles
    // below. Grafana's alerting cannot watch Grafana, so something without a
    // dependency on Grafana's database has to.
    //
    // ⚠️ An Alertmanager with nothing routed to it would be the same trap as
    // the `default-receiver` and the dead `pushgateway` key: healthy-looking
    // and doing nothing. If the watchdog rule above is ever removed, remove
    // this too rather than leaving it running empty.
    alertmanager: {
      enabled: true,
      // ⚠️ `persistence`, not `persistentVolume`. Alertmanager is a *subchart*
      // with its own key naming; `server` above uses `persistentVolume` and
      // both are correct for their own chart. Getting it wrong is silent — the
      // unknown key is ignored, the PVC is created with no storageClassName at
      // all, and it sits Pending with "no persistent volumes available for
      // this claim and no storage class is set".
      persistence: {
        enabled: true,
        storageClass: "local-path",
        size: "5Gi",
      },
      // Pinned for the same reason as the server above.
      nodeSelector: onNode(MAXDATA),
      resources: {
        requests: {
          cpu: "100m",
          memory: "256Mi",
        },
        limits: {
          cpu: "500m",
          memory: "512Mi",
        },
      },
      // The ntfy publishing credential, as a file.
      //
      // ⚠️ Mounted rather than inlined because this subchart renders `config`
      // below into a plain **ConfigMap**, not a Secret — an inline `password:`
      // would be readable by anything able to read ConfigMaps in this
      // namespace. The Secret's keys become filenames, so `password` lands at
      // `/etc/alertmanager/ntfy/password`.
      extraSecretMounts: [
        {
          name: "ntfy-credentials",
          mountPath: "/etc/alertmanager/ntfy",
          subPath: "",
          secretName: ntfyAlertCredentials.metadata.name,
          readOnly: true,
        },
      ],
      // ⚠️ Until this block existed, Alertmanager ran the chart's default
      // `default-receiver` — a receiver with a name and **no destination at
      // all**. Alerts were grouped, deduplicated and then dropped, and nothing
      // reported an error, because delivering to nowhere is not a failure. The
      // alert rules in `serverFiles` below were therefore decorative.
      config: {
        global: {},
        route: {
          group_wait: "30s",
          group_interval: "5m",
          // 12 h rather than the chart's 3 h: these alerts are slow-moving
          // (a certificate expiring, an ingress down), so re-notifying every
          // three hours trains you to ignore the notification.
          repeat_interval: "12h",
          receiver: "ntfy",
        },
        receivers: [
          {
            name: "ntfy",
            webhook_configs: [
              {
                // ⚠️ `?template=alertmanager` is a **built-in ntfy template**,
                // not something defined here — verified present in the running
                // v2.27.0 (`server/templates/alertmanager.yml`). Without it,
                // ntfy publishes Alertmanager's raw JSON as the message body,
                // which arrives as an unreadable wall of text on the phone.
                // The template reads `.labels.severity`, `.annotations.summary`
                // and `.annotations.description`, which the rules below set.
                url: pulumi.interpolate`http://ntfy.${namespaceName}.svc.cluster.local/${ntfyAlertTopic}?template=alertmanager`,
                send_resolved: true,
                http_config: {
                  basic_auth: {
                    username: "alertmanager",
                    password_file: "/etc/alertmanager/ntfy/password",
                  },
                },
              },
            ],
          },
        ],
      },
    },

    // Pushgateway - for short-lived jobs.
    //
    // ⚠️ The subchart is keyed `prometheus-pushgateway`, not `pushgateway` —
    // the same trap as `prometheus-node-exporter` below. This block previously
    // read `pushgateway: { enabled: false }`, which is an unknown key: Helm
    // silently ignored it and the subchart ran on its own default the whole
    // time. The config said the Pushgateway was off while it was serving
    // traffic, which is the worst of both.
    //
    // It is now genuinely wanted rather than merely tolerated:
    // `databases/backup.ts` pushes a completion timestamp here after every
    // nightly dump, and the backup-age alert reads it. Turning this off breaks
    // that alert *silently* — a missing series looks the same as a series that
    // has not fired.
    "prometheus-pushgateway": {
      enabled: true,
    },

    // Node Exporter - collects node-level metrics
    // ⚠️ The subchart is keyed `prometheus-node-exporter`, not `nodeExporter`.
    // This block previously used the latter and was therefore ignored in its
    // entirety — including its tolerations. The DaemonSet reaches ionos only
    // because the subchart's own default toleration is a blanket
    // `NoSchedule / Exists`, not because anything here asked for it.
    "prometheus-node-exporter": {
      enabled: true,
      // ⚠️ Skip maxdata. It already runs a **native** node_exporter on 9100
      // from NixOS (hosts/nixos/maxdata/monitoring.nix), and this DaemonSet
      // uses host networking, so both cannot bind: the pod crash-loops with
      // "listen tcp 0.0.0.0:9100: bind: address already in use" and blocks the
      // whole rollout waiting for a DaemonSet that can never be fully ready.
      //
      // Excluding it rather than disabling the DaemonSet keeps coverage of the
      // three nodes that have no native exporter, and keeps maxdata's ZFS and
      // smartctl exporters, which exist nowhere else.
      //
      // ⚠️ Interim. The layering table assigns node/ZFS/smartctl exporters to
      // NixOS while this chart ships its own DaemonSet, so the estate is
      // currently doing both. Phase 12 should settle which one owns them.
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [
              {
                matchExpressions: [
                  {
                    key: HOSTNAME_LABEL,
                    operator: "NotIn",
                    values: [MAXDATA],
                  },
                ],
              },
            ],
          },
        },
      },
    },

    // Kube State Metrics - exposes cluster state metrics
    kubeStateMetrics: {
      enabled: true,
    },

    // Scrape configs - what Prometheus monitors
    serverFiles: {
      // Alert rules.
      //
      // These exist because of a failure mode introduced on 2026-08-07: every
      // certificate in the estate is now issued by HTTP-01 through the public
      // Traefik on ionos (D8/D16). Renewal therefore depends on that path
      // staying reachable from the internet rather than on a DNS record — and
      // when it breaks, **nothing looks wrong**. Certificates keep working for
      // another month, then everything expires at once, long after whatever
      // caused it. That is precisely the shape of failure a monitoring stack
      // is for, and the one it could not previously report.
      // Alert rules.
      //
      // ⚠️ **Almost everything that used to live here now lives in Grafana**
      // (`monitoring/grafana.ts`, Phase C). Certificates, public ingress and
      // ZFS were ported there so the estate has one alerting system rather
      // than two. Do not add application alerts here; add them to Grafana.
      //
      // What remains is the one rule that *cannot* live in Grafana, for a
      // reason worth stating plainly:
      //
      //   Grafana's unified alerting keeps its rules, its evaluation state and
      //   its notification history in Grafana's own database — which is now
      //   `postgres-winkel` on maxdata. So Grafana cannot alert on Grafana
      //   being down, and it cannot reliably alert on its own database being
      //   down either. Left alone, that is circular: `PostgresBackupStale`, the
      //   alert about the databases, is hosted by something that needs a
      //   database to run.
      //
      // Prometheus and Alertmanager have no such dependency — they hold rules
      // in a ConfigMap and state on local disk. Keeping this single rule here
      // means the two systems watch each other.
      //
      // ⚠️ This is *not* redundancy against losing maxdata. Prometheus,
      // Alertmanager, Grafana and ntfy all run there, so a maxdata outage
      // silences all of it. `monitoring/deadmans-switch.ts` is what covers
      // that case, deliberately unpinned and reporting to a third party.
      "alerting_rules.yml": {
        groups: [
          {
            name: "alerting-watchdog",
            rules: [
              {
                // 10m rather than something tighter: Grafana legitimately
                // restarts on any config change, and this must not page for a
                // rollout. Long enough to ignore a rollout, short enough that a
                // silent alerting stack is caught the same day.
                alert: "GrafanaAlertingDown",
                expr: 'kube_deployment_status_replicas_available{deployment="grafana"} == 0',
                for: "10m",
                labels: { severity: "critical" },
                annotations: {
                  summary:
                    "Grafana has no available replica — unified alerting is not evaluating",
                  description:
                    "Every alert in the estate except this one is evaluated by Grafana, so while this fires nothing else can report anything. Grafana depends on postgres-winkel; check that cluster first, then `kubectl -n monitoring logs deploy/grafana`.",
                },
              },
            ],
          },
        ],
      },
      "prometheus.yml": {
        scrape_configs: [
          // Home Assistant - requires bearer token authentication
          {
            job_name: "homeassistant",
            static_configs: [
              {
                targets: ["homeassistant.homeassistant.svc.cluster.local:80"],
                labels: {
                  namespace: "homeassistant",
                  app: "homeassistant",
                },
              },
            ],
            metrics_path: "/api/prometheus",
            bearer_token_file:
              "/etc/prometheus/secrets/homeassistant-prometheus-token/token",
            scrape_interval: "30s",
          },
          // Kube-state-metrics - cluster state metrics
          {
            job_name: "kube-state-metrics",
            static_configs: [
              {
                targets: [
                  "prometheus-kube-state-metrics.monitoring.svc.cluster.local:8080",
                ],
              },
            ],
          },
          // Node Exporter - node-level metrics
          {
            job_name: "node-exporter",
            kubernetes_sd_configs: [
              {
                role: "endpoints",
              },
            ],
            relabel_configs: [
              {
                source_labels: ["__meta_kubernetes_endpoints_name"],
                action: "keep",
                regex: "prometheus-prometheus-node-exporter",
              },
              {
                source_labels: ["__meta_kubernetes_endpoint_node_name"],
                action: "replace",
                target_label: "instance",
              },
            ],
          },
          // Maxdata host - bare metal Proxmox/ZFS server
          {
            job_name: "maxdata",
            static_configs: [
              {
                targets: ["192.168.178.2:9100"],
                labels: {
                  instance: "maxdata",
                  host: "maxdata",
                  role: "storage",
                  environment: "homelab",
                },
              },
            ],
            scrape_interval: "15s",
          },
          // Maxdata ZFS metrics
          {
            job_name: "maxdata-zfs",
            static_configs: [
              {
                targets: ["192.168.178.2:9134"],
                labels: {
                  instance: "maxdata",
                  host: "maxdata",
                  role: "storage",
                  environment: "homelab",
                  exporter: "zfs",
                },
              },
            ],
            scrape_interval: "30s",
          },
          // Maxdata Smartmon metrics
          {
            job_name: "maxdata-smartctl",
            static_configs: [
              {
                targets: ["192.168.178.2:9116"],
                labels: {
                  instance: "maxdata",
                  host: "maxdata",
                  role: "storage",
                  environment: "homelab",
                },
              },
            ],
            scrape_interval: "60s",
          },
          // brink-server and winkel-pi ZFS/smartctl exporters (setup repo,
          // hosts/nixos/{brink-server,winkel-pi}/monitoring.nix, Phase 12).
          //
          // ⚠️ Targets are each host's *overlay* address (100.64.0.x), not its
          // LAN IP like maxdata above. maxdata's scrape works at its LAN IP
          // only because the Prometheus pod is itself pinned to maxdata
          // (nodeSelector above) — same-node traffic, trivially reachable.
          // brink-server and winkel-pi are different nodes, and maxdata does
          // not accept their subnet routes (D3/overlay-client.nix: only
          // subnet routers accept routes), so their LAN IPs are unreachable
          // from here. The overlay address is always reachable regardless —
          // that's the mesh's own point-to-point routing, not a subnet route
          // — which is also why the exporters are firewalled to the overlay
          // interface only on the NixOS side.
          {
            job_name: "brink-server-zfs",
            static_configs: [
              {
                targets: ["100.64.0.2:9134"],
                labels: {
                  instance: "brink-server",
                  host: "brink-server",
                  role: "storage",
                  environment: "homelab",
                  exporter: "zfs",
                },
              },
            ],
            scrape_interval: "30s",
          },
          {
            job_name: "brink-server-smartctl",
            static_configs: [
              {
                targets: ["100.64.0.2:9116"],
                labels: {
                  instance: "brink-server",
                  host: "brink-server",
                  role: "storage",
                  environment: "homelab",
                },
              },
            ],
            scrape_interval: "60s",
          },
          {
            job_name: "winkel-pi-smartctl",
            static_configs: [
              {
                targets: ["100.64.0.3:9116"],
                labels: {
                  instance: "winkel-pi",
                  host: "winkel-pi",
                  role: "storage",
                  environment: "homelab",
                },
              },
            ],
            scrape_interval: "60s",
          },
          // Cross-site ICMP probes (monitoring/blackbox.ts). blackbox-exporter
          // itself is pinned to maxdata, so these measure latency/loss *from*
          // Winkel — winkel-pi is same-LAN (control measurement, not
          // cross-site), brink-server and ionos are the genuine WAN legs.
          // Standard blackbox_exporter relabeling: the real target becomes
          // `__param_target`, and `instance` is set from it before
          // `__address__` is overwritten with the exporter's own address.
          {
            job_name: "blackbox-icmp",
            metrics_path: "/probe",
            params: { module: ["icmp"] },
            static_configs: [
              {
                targets: ["100.64.0.2"],
                labels: {
                  target_host: "brink-server",
                  site: "brink",
                  cross_site: "true",
                },
              },
              {
                targets: ["100.64.0.1"],
                labels: {
                  target_host: "ionos",
                  site: "public",
                  cross_site: "true",
                },
              },
              {
                targets: ["100.64.0.3"],
                labels: {
                  target_host: "winkel-pi",
                  site: "winkel",
                  cross_site: "false",
                },
              },
            ],
            relabel_configs: [
              {
                source_labels: ["__address__"],
                target_label: "__param_target",
              },
              {
                source_labels: ["__param_target"],
                target_label: "instance",
              },
              {
                target_label: "__address__",
                replacement: blackboxServiceUrl,
              },
            ],
            scrape_interval: "30s",
          },
        ],
      },
    },
  },
});

// Export Prometheus service URL for Grafana data source
export const prometheusUrl =
  "http://prometheus-server.monitoring.svc.cluster.local";

export { prometheus };

// Usage:
//
// Prometheus UI: https://prometheus.mvissing.de
//
// For applications to expose metrics to Prometheus:
//
// 1. Add these annotations to your pod/deployment:
//    metadata:
//      annotations:
//        prometheus.io/scrape: "true"
//        prometheus.io/port: "8080"        # Port where metrics are exposed
//        prometheus.io/path: "/metrics"    # Path to metrics endpoint (default)
//
// 2. Expose metrics in your application (example for Node.js):
//    - Use prom-client library
//    - Expose /metrics endpoint
//
// 3. Verify scraping:
//    - Go to Prometheus UI → Status → Targets
//    - Your pod should appear in the "kubernetes-pods" job
//
// PromQL Query Examples:
//   - CPU usage: rate(container_cpu_usage_seconds_total[5m])
//   - Memory usage: container_memory_working_set_bytes
//   - Pod count: count(kube_pod_info)
//   - HTTP request rate: rate(http_requests_total[5m])
//
// Retention: 1 year (365 days)
// Storage: 100Gi on local-path (ZFS backed with automatic sanoid snapshots)
