// MetalLB - LoadBalancer implementation for bare metal Kubernetes
// Provides LoadBalancer IPs for services in the K3s cluster

import * as k8s from "@pulumi/kubernetes";

// Create metallb-system namespace
const namespace = new k8s.core.v1.Namespace("metallb-system", {
  metadata: { name: "metallb-system" },
});

// Deploy MetalLB using Helm
const metallb = new k8s.helm.v3.Release("metallb", {
  chart: "metallb",
  version: "0.15.3",
  namespace: namespace.metadata.name,
  repositoryOpts: {
    repo: "https://metallb.github.io/metallb",
  },
  values: {
    // Enable Prometheus metrics scraping via pod annotations
    prometheus: {
      scrapeAnnotations: true,
      metricsPort: 7472,
    },
    speaker: {
      frr: {
        metricsPort: 7473,
      },
    },
  },
});

// Configure IP address pool for LoadBalancer services
// This assigns IPs from the local network range
const ipAddressPool = new k8s.apiextensions.CustomResource(
  "ip-pool",
  {
    apiVersion: "metallb.io/v1beta1",
    kind: "IPAddressPool",
    metadata: {
      name: "default-pool",
      namespace: namespace.metadata.name,
    },
    spec: {
      addresses: [
        // Reserve IPs for LoadBalancer services
        // Using .10-.20 range to avoid conflicts with static IPs
        "192.168.178.10-192.168.178.20",
        // IPv6 range for dual-stack
        "fda8:a1db:5685::10-fda8:a1db:5685::20",
      ],
    },
  },
  { dependsOn: [metallb] }
);

// L2 Advertisement - announces the LoadBalancer IPs on the local network
const l2Advertisement = new k8s.apiextensions.CustomResource(
  "l2-advertisement",
  {
    apiVersion: "metallb.io/v1beta1",
    kind: "L2Advertisement",
    metadata: {
      name: "default",
      namespace: namespace.metadata.name,
    },
    spec: {
      ipAddressPools: ["default-pool"],
    },
  },
  { dependsOn: [ipAddressPool] }
);

export { metallb, ipAddressPool, l2Advertisement };