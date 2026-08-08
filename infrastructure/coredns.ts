// CoreDNS: pin `mvissing.de` to the site resolvers that do split-horizon.
//
// ⚠️ WHY THIS EXISTS — it fixes a defect that presents as a TLS error.
//
// k3s's Corefile ends with `forward . /etc/resolv.conf`, so CoreDNS inherits
// whatever DNS servers its *node* has. brink-server — where the single CoreDNS
// replica runs — lists two: its own AdGuard on 192.168.1.2, and the UDM SE on
// 192.168.1.1. Only the first applies the split-horizon rewrites:
//
//   dig @192.168.1.2 auth.mvissing.de  ->  192.168.1.240      (site ingress)
//   dig @192.168.1.1 auth.mvissing.de  ->  212.132.82.102     (public edge)
//
// CoreDNS's `forward` plugin defaults to `policy random`, so this is not
// failover — it is a coin flip on every cache miss. Roughly half of all
// in-cluster lookups of any `*.mvissing.de` name returned the public edge,
// which is default-closed and answers with TRAEFIK DEFAULT CERT. Anything
// making a server-side HTTPS call to one of these names then fails certificate
// verification.
//
// ⚠️ It does not look like a DNS fault. Paperless returned a plain HTTP 500 on
// the SSO login, with `CERTIFICATE_VERIFY_FAILED: self-signed certificate` for
// the Authentik discovery URL buried in its traceback — which reads as a
// certificate or Authentik problem, and is neither. `cache 30` holds each
// answer for 30 s, so it comes and goes in half-minute blocks and reads as
// flaky rather than broken. Grafana's OAuth token exchange has the same shape.
//
// ⚠️ Testing this needs a client that *validates*. The first check here used
// busybox `wget` from another pod, which does not — it reported success three
// times out of three against the very certificate that was failing.
//
// The host-side half of the fix is in the `setup` repo: brink-server should not
// carry the UDM SE as a resolver at all, since it bypasses ad-blocking as well
// as split-horizon. This block is the cluster-side half, and is what keeps the
// cluster correct regardless of what a node's resolv.conf happens to say.

import * as k8s from "@pulumi/kubernetes";
import { sites, SPLIT_HORIZON_ZONE } from "./sites";

// k3s's Corefile imports `/etc/coredns/custom/*.server` *after* the `.:53`
// block, and the coredns Deployment already mounts the `coredns-custom`
// ConfigMap there with `optional: true`. A server block for a specific zone
// takes precedence over `.:53`, so this diverts only `mvissing.de` and leaves
// every other name on the node's resolvers.
//
// `policy sequential` rather than the default `random`: the two site resolvers
// are equally correct but each returns *its own* site's ingress VIP, so a
// random pick would send half of Winkel's in-cluster traffic across the WAN
// overlay to Brink's Traefik. Sequential prefers the first and falls through
// only when it does not answer, which keeps the second as genuine failover.
// Brink is first because that is where CoreDNS runs.
//
// ⚠️ Both entries must be split-horizon resolvers. Adding a plain upstream here
// as a "fallback" would reintroduce exactly the defect this file exists to fix,
// and it would do so intermittently.
const corefile = `${SPLIT_HORIZON_ZONE}:53 {
    errors
    cache 30
    forward . ${sites.brink.resolver} ${sites.winkel.resolver} {
        policy sequential
    }
}
`;

export const corednsCustom = new k8s.core.v1.ConfigMap(
  "coredns-custom",
  {
    metadata: {
      // ⚠️ The name is fixed by k3s, not chosen: the Deployment mounts a
      // ConfigMap called exactly `coredns-custom`. It therefore cannot use the
      // auto-naming that `local-path.ts` relies on to dodge the replace
      // collision — hence `deleteBeforeReplace` below.
      name: "coredns-custom",
      namespace: "kube-system",
    },
    data: {
      // The key must end in `.server`; `*.override` is for the main block.
      [`${SPLIT_HORIZON_ZONE}.server`]: corefile,
    },
  },
  {
    // pulumi-kubernetes treats any change to a ConfigMap's `.data` as a
    // replacement, and replacement is create-before-delete — which collides
    // with the object still present when the name is fixed. Deleting first
    // avoids `configmaps "coredns-custom" already exists`.
    //
    // ⚠️ The cost is a brief window with no custom block, during which
    // `*.mvissing.de` falls back to the node's resolvers and can again answer
    // with the public edge. Only on changes to this ConfigMap.
    deleteBeforeReplace: true,
  },
);
