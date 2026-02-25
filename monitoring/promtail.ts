// Promtail - Log collection agent
// Runs as DaemonSet on every node to collect logs from all pods
// Ships logs to Loki for aggregation and storage

import * as k8s from "@pulumi/kubernetes";
import { namespaceName } from "./namespace";
import { lokiUrl } from "./loki";

// Install Promtail using Helm chart
const promtail = new k8s.helm.v3.Chart("promtail", {
  chart: "promtail",
  version: "6.17.1",
  namespace: namespaceName,
  fetchOpts: {
    repo: "https://grafana.github.io/helm-charts",
  },
  values: {
    // Promtail configuration
    config: {
      // Loki endpoint - where to send logs
      clients: [
        {
          url: `${lokiUrl}/loki/api/v1/push`,
        },
      ],

      // Scrape configs - what logs to collect
      snippets: {
        scrapeConfigs: `
# Paperless pods - with multiline support for Python/Django stack traces
- job_name: kubernetes-pods-paperless
  pipeline_stages:
    - cri: {}
    # Multiline support for Python stack traces
    # Matches log lines starting with [YYYY-MM-DD HH:MM:SS,mmm]
    - multiline:
        firstline: '^\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2},\\d{3}\\]'
        max_wait_time: 3s
        max_lines: 100
    # Parse Paperless log format: [timestamp] [level] [logger] message
    - regex:
        expression: '^\\[(?P<timestamp>\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2},\\d{3})\\] \\[(?P<level>\\w+)\\] \\[(?P<logger>[^\\]]+)\\] (?P<message>.*)$'
    # Set log level as a label for filtering
    - labels:
        level:
        logger:
    # Use extracted timestamp (Paperless logs in Europe/Berlin timezone)
    - timestamp:
        source: timestamp
        format: '2006-01-02 15:04:05,000'
        location: Europe/Berlin
    # Replace log line with just the message (optional - keeps full line if commented)
    - output:
        source: message
  kubernetes_sd_configs:
    - role: pod
  relabel_configs:
    # Only scrape paperless namespace
    - source_labels:
        - __meta_kubernetes_namespace
      regex: paperless
      action: keep

    # Only scrape local pods (on same node)
    - source_labels:
        - __meta_kubernetes_pod_node_name
      target_label: __host__

    # Add namespace label
    - source_labels:
        - __meta_kubernetes_namespace
      target_label: namespace

    # Add pod name label
    - source_labels:
        - __meta_kubernetes_pod_name
      target_label: pod

    # Add container name label
    - source_labels:
        - __meta_kubernetes_pod_container_name
      target_label: container

    # Add app label if it exists
    - source_labels:
        - __meta_kubernetes_pod_label_app
      target_label: app

    # Path to log files
    - source_labels:
        - __meta_kubernetes_pod_uid
        - __meta_kubernetes_pod_container_name
      target_label: __path__
      separator: /
      replacement: /var/log/pods/*$1/*.log

    # Drop empty labels
    - action: labelmap
      regex: __meta_kubernetes_pod_label_(.+)

# All other pods - with JSON timestamp support
- job_name: kubernetes-pods
  pipeline_stages:
    - cri: {}
    # Try to parse as JSON and extract timestamp
    - json:
        expressions:
          ts: ts
          level: level
          msg: msg
    # Use ts field as timestamp (Unix milliseconds)
    - timestamp:
        source: ts
        format: UnixMs
    # Add level as label if present
    - labels:
        level:
  kubernetes_sd_configs:
    - role: pod
  relabel_configs:
    # Exclude paperless namespace (handled by job above)
    - source_labels:
        - __meta_kubernetes_namespace
      regex: paperless
      action: drop

    # Only scrape local pods (on same node)
    - source_labels:
        - __meta_kubernetes_pod_node_name
      target_label: __host__

    # Add namespace label
    - source_labels:
        - __meta_kubernetes_namespace
      target_label: namespace

    # Add pod name label
    - source_labels:
        - __meta_kubernetes_pod_name
      target_label: pod

    # Add container name label
    - source_labels:
        - __meta_kubernetes_pod_container_name
      target_label: container

    # Add app label if it exists
    - source_labels:
        - __meta_kubernetes_pod_label_app
      target_label: app

    # Path to log files
    - source_labels:
        - __meta_kubernetes_pod_uid
        - __meta_kubernetes_pod_container_name
      target_label: __path__
      separator: /
      replacement: /var/log/pods/*$1/*.log

    # Drop empty labels
    - action: labelmap
      regex: __meta_kubernetes_pod_label_(.+)
`,
      },
    },

    // DaemonSet - run on every node
    daemonset: {
      enabled: true,
    },

    // Resource limits for Promtail
    resources: {
      requests: {
        cpu: "100m",
        memory: "128Mi",
      },
      limits: {
        cpu: "200m",
        memory: "256Mi",
      },
    },

    // Tolerations - allow running on all nodes including control plane
    tolerations: [
      {
        effect: "NoSchedule",
        operator: "Exists",
      },
    ],
  },
});

export { promtail };

// Usage:
//
// Promtail automatically collects logs from all pods on all nodes
// No additional configuration needed in your applications
//
// Logs include automatic labels:
//   - namespace: Kubernetes namespace
//   - pod: Pod name
//   - container: Container name
//   - app: App label (if set)
//   - All pod labels are also added
//
// Query in Grafana using these labels:
//   {namespace="monitoring"}
//   {app="grafana"}
//   {pod=~"postgres-.*"}
//
// Promtail runs as a DaemonSet with one pod per node
// Check status: kubectl get pods -n monitoring -l app.kubernetes.io/name=promtail