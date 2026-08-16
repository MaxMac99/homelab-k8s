// Blackbox exporter — cross-site ICMP probes (latency, packet loss).
// Phase 12 (setup repo, docs/multi-site-migration.md).
//
// Pinned to maxdata, the same as Prometheus itself, so every probe measures
// the same vantage point over time rather than a latency baseline that shifts
// whenever the pod gets rescheduled. That means this only measures *from*
// Winkel: winkel-pi is same-LAN (kept as a same-site control measurement, not
// a cross-site one) and brink-server/ionos are the genuine cross-site legs.
// Bidirectional (brink/ionos probing back) is future work, not this pass.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { namespaceName } from "./namespace";
import { onNode, MAXDATA } from "../infrastructure/sites";

const blackboxConfig = new k8s.core.v1.ConfigMap("blackbox-exporter-config", {
  metadata: {
    name: "blackbox-exporter-config",
    namespace: namespaceName,
  },
  data: {
    "blackbox.yml": `
modules:
  icmp:
    prober: icmp
    timeout: 5s
    icmp:
      preferred_ip_protocol: "ip4"
`,
  },
});

const blackboxDeployment = new k8s.apps.v1.Deployment("blackbox-exporter", {
  metadata: {
    name: "blackbox-exporter",
    namespace: namespaceName,
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: { app: "blackbox-exporter" },
    },
    template: {
      metadata: {
        labels: { app: "blackbox-exporter" },
      },
      spec: {
        nodeSelector: onNode(MAXDATA),
        containers: [
          {
            name: "blackbox-exporter",
            image: "prom/blackbox-exporter:v0.26.0",
            args: ["--config.file=/etc/blackbox/blackbox.yml"],
            ports: [{ name: "http", containerPort: 9115 }],
            // The icmp module needs a raw socket. Rather than run the whole
            // container as root, add exactly the one capability it needs.
            securityContext: {
              capabilities: { add: ["NET_RAW"] },
            },
            volumeMounts: [{ name: "config", mountPath: "/etc/blackbox" }],
            resources: {
              requests: { cpu: "10m", memory: "16Mi" },
              limits: { cpu: "50m", memory: "32Mi" },
            },
          },
        ],
        volumes: [
          {
            name: "config",
            configMap: { name: blackboxConfig.metadata.name },
          },
        ],
      },
    },
  },
});

const blackboxService = new k8s.core.v1.Service("blackbox-exporter", {
  metadata: {
    name: "blackbox-exporter",
    namespace: namespaceName,
  },
  spec: {
    selector: { app: "blackbox-exporter" },
    ports: [{ name: "http", port: 9115, targetPort: 9115 }],
    type: "ClusterIP",
  },
});

// ⚠️ ClusterIP, not the DNS name. Found live 2026-08-16: any hostname-based
// lookup from the prometheus-server pod (maxdata) hangs to context-deadline,
// including the bare short name `blackbox-exporter` — while both the numeric
// ClusterIP and the pod IP resolve and connect instantly. CoreDNS itself is
// healthy (1/1, on brink-server), so this is DNS resolution specifically,
// not Service routing, and it is cross-node (maxdata -> CoreDNS on
// brink-server) — worth treating as a real, separate finding rather than a
// blackbox-exporter problem. See docs/multi-site-migration.md Phase 12.
// `.spec.clusterIP` is a live Pulumi-tracked value, not a copy-pasted
// string, so this stays correct if the Service is ever recreated.
export const blackboxServiceUrl = pulumi.interpolate`${blackboxService.spec.clusterIP}:9115`;

export { blackboxDeployment, blackboxService };
