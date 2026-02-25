// Monitoring namespace
// Contains Prometheus, Grafana, Loki, Tempo, and related monitoring infrastructure

import * as k8s from "@pulumi/kubernetes";

// Create namespace for monitoring stack
export const namespace = new k8s.core.v1.Namespace("monitoring", {
  metadata: {
    name: "monitoring",
  },
});

export const namespaceName = namespace.metadata.name;