// Grafana Alloy - Log collection agent
// DaemonSet that tails pod logs via the Kubernetes API and ships them to Loki.
// Replaces Promtail, which went end-of-life in March 2026.

import * as k8s from "@pulumi/kubernetes";
import { namespaceName } from "./namespace";
import { lokiUrl } from "./loki";

// River config: discover pods on the current node, split into a paperless
// pipeline (multiline Python stack traces, regex-parsed timestamps) and a
// default pipeline (JSON `ts` field as timestamp), then forward to Loki.
const alloyConfig = `
logging {
  level = "info"
}

discovery.kubernetes "pods" {
  role = "pod"
  selectors {
    role  = "pod"
    field = "spec.nodeName=" + sys.env("NODE_NAME")
  }
}

discovery.relabel "pods" {
  targets = discovery.kubernetes.pods.targets

  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_container_name"]
    target_label  = "container"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    target_label  = "app"
  }
  rule {
    action = "labelmap"
    regex  = "__meta_kubernetes_pod_label_(.+)"
  }
}

discovery.relabel "paperless" {
  targets = discovery.relabel.pods.output
  rule {
    source_labels = ["namespace"]
    regex         = "paperless"
    action        = "keep"
  }
}

discovery.relabel "others" {
  targets = discovery.relabel.pods.output
  rule {
    source_labels = ["namespace"]
    regex         = "paperless"
    action        = "drop"
  }
}

// Systemd journal logs from the host node
loki.source.journal "journal" {
  forward_to = [loki.relabel.journal.receiver]
  max_age    = "12h"
  labels     = {
    job = "systemd-journal",
  }
}

loki.relabel "journal" {
  forward_to = [loki.write.default.receiver]

  rule {
    source_labels = ["__journal__systemd_unit"]
    target_label  = "unit"
  }
  rule {
    source_labels = ["__journal__hostname"]
    target_label  = "hostname"
  }
  rule {
    source_labels = ["__journal_priority_keyword"]
    target_label  = "level"
  }
}

loki.source.kubernetes "paperless" {
  targets    = discovery.relabel.paperless.output
  forward_to = [loki.process.paperless.receiver]
}

loki.source.kubernetes "others" {
  targets    = discovery.relabel.others.output
  forward_to = [loki.process.others.receiver]
}

loki.process "paperless" {
  forward_to = [loki.write.default.receiver]

  stage.multiline {
    firstline     = \`^\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2},\\d{3}\\]\`
    max_wait_time = "3s"
    max_lines     = 100
  }

  stage.regex {
    expression = \`^\\[(?P<timestamp>\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2},\\d{3})\\] \\[(?P<level>\\w+)\\] \\[(?P<logger>[^\\]]+)\\] (?P<message>.*)$\`
  }

  stage.labels {
    values = {
      level  = "",
      logger = "",
    }
  }

  stage.timestamp {
    source   = "timestamp"
    format   = "2006-01-02 15:04:05,000"
    location = "Europe/Berlin"
  }

  stage.output {
    source = "message"
  }
}

loki.process "others" {
  forward_to = [loki.write.default.receiver]

  stage.json {
    expressions = {
      ts    = "ts",
      level = "level",
      msg   = "msg",
    }
  }

  stage.timestamp {
    source = "ts"
    format = "UnixMs"
  }

  stage.labels {
    values = {
      level = "",
    }
  }
}

loki.write "default" {
  endpoint {
    url = "${lokiUrl}/loki/api/v1/push"
  }
}
`;

const alloy = new k8s.helm.v3.Chart("alloy", {
  chart: "alloy",
  version: "1.7.0",
  namespace: namespaceName,
  fetchOpts: {
    repo: "https://grafana.github.io/helm-charts",
  },
  values: {
    alloy: {
      configMap: {
        create: true,
        content: alloyConfig,
      },

      // NODE_NAME is required by the spec.nodeName field selector above.
      extraEnv: [
        {
          name: "NODE_NAME",
          valueFrom: {
            fieldRef: {
              fieldPath: "spec.nodeName",
            },
          },
        },
      ],

      mounts: {
        extra: [
          {
            name: "journal",
            mountPath: "/var/log/journal",
            readOnly: true,
          },
          {
            name: "machine-id",
            mountPath: "/etc/machine-id",
            readOnly: true,
          },
        ],
      },

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
    },

    controller: {
      type: "daemonset",
      tolerations: [
        {
          effect: "NoSchedule",
          operator: "Exists",
        },
      ],
      volumes: {
        extra: [
          {
            name: "journal",
            hostPath: {
              path: "/var/log/journal",
            },
          },
          {
            name: "machine-id",
            hostPath: {
              path: "/etc/machine-id",
            },
          },
        ],
      },
    },
  },
});

export { alloy };

// Usage:
//
// Alloy runs as a DaemonSet and tails pod logs via the Kubernetes API
// (pods/log). No host path mounts required.
//
// Automatic labels:
//   - namespace, pod, container, app (from pod label `app`)
//   - level, logger (extracted by pipeline stages)
//   - Any other pod label (via labelmap)
//
// Query in Grafana using these labels:
//   {namespace="monitoring"}
//   {app="grafana"}
//   {pod=~"postgres-.*"}
//
// Check status: kubectl get pods -n monitoring -l app.kubernetes.io/name=alloy
// Live config:  kubectl port-forward -n monitoring ds/alloy 12345 then open http://localhost:12345
