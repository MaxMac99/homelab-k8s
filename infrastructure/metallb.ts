// MetalLB - LoadBalancer implementation for bare metal Kubernetes
// Provides LoadBalancer IPs for services in the K3s cluster

import * as k8s from "@pulumi/kubernetes";
import { sites, ZONE_LABEL } from "./sites";

// Create metallb-system namespace
const namespace = new k8s.core.v1.Namespace("metallb-system", {
  metadata: { name: "metallb-system" },
});

// Deploy MetalLB using Helm
const metallb = new k8s.helm.v3.Release("metallb", {
  chart: "metallb",
  version: "0.16.1",
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

// One pool per site.
//
// L2 mode announces an address by answering ARP for it, which only works on a
// segment the announcing node shares with the client. The two sites are
// different L2 segments joined by a WireGuard overlay, so a single pool cannot
// serve both — an address from Winkel's range announced at Brink is announced
// to nobody.
//
// `autoAssign: false` on both pools is deliberate. It means a LoadBalancer
// service with no explicit address gets *no* address and stays visibly
// Pending, rather than silently taking whatever is free. That is exactly the
// failure this phase exists to end: the old cluster's Traefik held
// 192.168.178.10 by first-come luck from the pool, not by configuration, and a
// rebuild does not reproduce it — while six iptables DNAT rules on ionos
// depended on that address.
//
// There is no `public` pool. ionos has no LAN segment to ARP on; it is reached
// over its fixed public address, and Phase 9 gives it a hostNetwork Traefik
// instead.
const brinkPool = new k8s.apiextensions.CustomResource(
  "ip-pool-brink",
  {
    apiVersion: "metallb.io/v1beta1",
    kind: "IPAddressPool",
    metadata: {
      name: "brink-pool",
      namespace: namespace.metadata.name,
    },
    spec: {
      addresses: [sites.brink.pool],
      autoAssign: false,
    },
  },
  { dependsOn: [metallb] },
);

const winkelPool = new k8s.apiextensions.CustomResource(
  "ip-pool-winkel",
  {
    apiVersion: "metallb.io/v1beta1",
    kind: "IPAddressPool",
    metadata: {
      name: "winkel-pool",
      namespace: namespace.metadata.name,
    },
    spec: {
      addresses: [sites.winkel.pool],
      autoAssign: false,
    },
  },
  { dependsOn: [metallb] },
);

// L2 advertisement, restricted to the nodes that can actually reach the segment.
//
// Without `nodeSelectors` every speaker is a candidate announcer, so Brink's
// addresses could be announced by a Winkel node — onto a segment where no
// client can hear them, while the site that needs them hears nothing.
const brinkL2Advertisement = new k8s.apiextensions.CustomResource(
  "l2-advertisement-brink",
  {
    apiVersion: "metallb.io/v1beta1",
    kind: "L2Advertisement",
    metadata: {
      name: "brink",
      namespace: namespace.metadata.name,
    },
    spec: {
      ipAddressPools: ["brink-pool"],
      // brink-server is the only node at Brink today. The selector is on the
      // zone rather than the hostname so a second Brink node needs no change
      // here.
      nodeSelectors: [{ matchLabels: { [ZONE_LABEL]: sites.brink.zone } }],
    },
  },
  { dependsOn: [brinkPool] },
);

const winkelL2Advertisement = new k8s.apiextensions.CustomResource(
  "l2-advertisement-winkel",
  {
    apiVersion: "metallb.io/v1beta1",
    kind: "L2Advertisement",
    metadata: {
      name: "winkel",
      namespace: namespace.metadata.name,
    },
    spec: {
      ipAddressPools: ["winkel-pool"],
      // maxdata and winkel-pi both sit on 192.168.178.0/24.
      nodeSelectors: [{ matchLabels: { [ZONE_LABEL]: sites.winkel.zone } }],
    },
  },
  { dependsOn: [winkelPool] },
);

export {
  metallb,
  brinkPool,
  winkelPool,
  brinkL2Advertisement,
  winkelL2Advertisement,
};
