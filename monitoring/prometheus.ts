// Prometheus - Metrics collection and monitoring
// Scrapes metrics from Kubernetes services and applications
// Accessible via prometheus.mvissing.de

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { namespaceName } from "./namespace";

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
  version: "27.48.0",
  namespace: namespaceName,
  fetchOpts: {
    repo: "https://prometheus-community.github.io/helm-charts",
  },
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
          "cert-manager.io/cluster-issuer": "letsencrypt-prod",
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

    // AlertManager - for handling alerts (optional, can be disabled initially)
    alertmanager: {
      enabled: true,
      persistentVolume: {
        enabled: true,
        storageClass: "local-path",
        size: "5Gi",
      },
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
    },

    // Pushgateway - for short-lived jobs (optional, disable if not needed)
    pushgateway: {
      enabled: false,
    },

    // Node Exporter - collects node-level metrics
    nodeExporter: {
      enabled: true,
      // Run on all nodes including control plane and edge nodes
      tolerations: [
        {
          effect: "NoSchedule",
          operator: "Exists",
        },
        {
          key: "edge",
          operator: "Equal",
          value: "true",
          effect: "NoSchedule",
        },
      ],
    },

    // Kube State Metrics - exposes cluster state metrics
    kubeStateMetrics: {
      enabled: true,
    },

    // Scrape configs - what Prometheus monitors
    serverFiles: {
      "prometheus.yml": {
        scrape_configs: [
          // Scrape Prometheus itself
          {
            job_name: "prometheus",
            static_configs: [
              {
                targets: ["localhost:9090"],
              },
            ],
          },
          // Kubernetes API server
          {
            job_name: "kubernetes-apiservers",
            kubernetes_sd_configs: [
              {
                role: "endpoints",
              },
            ],
            scheme: "https",
            tls_config: {
              ca_file: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
            },
            bearer_token_file:
              "/var/run/secrets/kubernetes.io/serviceaccount/token",
            relabel_configs: [
              {
                source_labels: [
                  "__meta_kubernetes_namespace",
                  "__meta_kubernetes_service_name",
                  "__meta_kubernetes_endpoint_port_name",
                ],
                action: "keep",
                regex: "default;kubernetes;https",
              },
            ],
          },
          // Kubernetes nodes
          {
            job_name: "kubernetes-nodes",
            kubernetes_sd_configs: [
              {
                role: "node",
              },
            ],
            scheme: "https",
            tls_config: {
              ca_file: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
            },
            bearer_token_file:
              "/var/run/secrets/kubernetes.io/serviceaccount/token",
            relabel_configs: [
              {
                action: "labelmap",
                regex: "__meta_kubernetes_node_label_(.+)",
              },
            ],
          },
          // Kubernetes cAdvisor - container metrics (CPU, memory, etc.)
          {
            job_name: "kubernetes-cadvisor",
            kubernetes_sd_configs: [
              {
                role: "node",
              },
            ],
            scheme: "https",
            metrics_path: "/metrics/cadvisor",
            tls_config: {
              ca_file: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
            },
            bearer_token_file:
              "/var/run/secrets/kubernetes.io/serviceaccount/token",
            relabel_configs: [
              {
                action: "labelmap",
                regex: "__meta_kubernetes_node_label_(.+)",
              },
            ],
          },
          // Kubernetes pods
          {
            job_name: "kubernetes-pods",
            kubernetes_sd_configs: [
              {
                role: "pod",
              },
            ],
            relabel_configs: [
              // Only scrape pods with prometheus.io/scrape annotation
              {
                source_labels: [
                  "__meta_kubernetes_pod_annotation_prometheus_io_scrape",
                ],
                action: "keep",
                regex: "true",
              },
              // Use custom path if specified
              {
                source_labels: [
                  "__meta_kubernetes_pod_annotation_prometheus_io_path",
                ],
                action: "replace",
                target_label: "__metrics_path__",
                regex: "(.+)",
              },
              // Use custom port if specified
              {
                source_labels: [
                  "__address__",
                  "__meta_kubernetes_pod_annotation_prometheus_io_port",
                ],
                action: "replace",
                regex: "([^:]+)(?::\\d+)?;(\\d+)",
                replacement: "$1:$2",
                target_label: "__address__",
              },
              // Add pod labels as metrics labels
              {
                action: "labelmap",
                regex: "__meta_kubernetes_pod_label_(.+)",
              },
              {
                source_labels: ["__meta_kubernetes_namespace"],
                action: "replace",
                target_label: "namespace",
              },
              {
                source_labels: ["__meta_kubernetes_pod_name"],
                action: "replace",
                target_label: "pod",
              },
            ],
          },
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
