// Public Traefik — the internet-facing ingress on ionos. Phase 9 / D16, Stage A.
//
// This is a *second* Traefik, separate from the per-site internal one in
// ./traefik.ts, and it exists for one reason first: cert-manager validates over
// HTTP-01 (D8 revised — no DNS-01, no IONOS API token, ever), which needs a
// live server on port 80 at the address the public DNS wildcard points to.
// That address is ionos, where Headscale answered every hostname until now.
//
// ⚠️ It has **no Service**. ionos has no LAN, so MetalLB cannot give it an
// address — L2 mode needs a segment to ARP on and a VPS has nobody to ARP
// with. Instead the pod runs `hostNetwork` pinned to ionos, and the native
// nginx in `hosts/nixos/ionos/public-ingress.nix` (the `setup` repo) proxies
// :80 into it on loopback. Reaching this Traefik therefore depends on a NixOS
// file in another repo that nothing here references — see the port note below.
//
// ⚠️ **Nothing is public unless it opts in.** Both providers are filtered:
// Ingresses need `ingressClassName: traefik-public`, IngressRoutes need the
// label `ingress=public`. Without that this Traefik would serve every internal
// route straight to the internet, since it watches the same cluster as the
// internal one. Default-closed is the whole point.

import * as k8s from "@pulumi/kubernetes";
import { traefikNamespace } from "./traefik";
import {
  publicSite,
  edgeToleration,
  publicIngressClass,
  publicRouteSelector,
} from "./sites";

// `publicIngressClass` is defined in ./sites.ts rather than here so that
// cert-manager.ts can name it for the HTTP-01 solver (D8) without closing an
// import cycle back through ./traefik.ts.

const traefikPublic = new k8s.helm.v3.Chart(
  "traefik-public",
  {
    chart: "traefik",
    version: "41.1.1",
    namespace: traefikNamespace.metadata.name,
    fetchOpts: {
      repo: "https://traefik.github.io/charts",
    },

    // ⚠️ Required, and not a preference. `helm.v3.Chart` turns every rendered
    // manifest into its own Pulumi resource, and the Traefik CRDs
    // (`tlsoptions.traefik.io` and friends) are cluster-scoped with fixed
    // names. Rendering them from a second release of the same chart collides
    // on the URN and the preview fails outright:
    //
    //   error: Duplicate resource URN '…:CustomResourceDefinition::tlsoptions.traefik.io'
    //
    // ./traefik.ts owns them. This release consumes them, and must be the same
    // chart version so it cannot want a CRD schema the other has not installed.
    skipCRDRendering: true,
    values: {
      deployment: {
        // One node can run it, so one replica. There is no second public edge
        // to spread across; ionos being down means no public ingress at all,
        // which is accepted (the sites keep working on their LANs).
        replicas: 1,
        // Required with hostNetwork, or the pod resolves against the node's
        // resolver and cannot see cluster DNS.
        dnsPolicy: "ClusterFirstWithHostNet",
      },

      // The pod's ports become host ports on ionos. That is the point: nginx
      // reaches them on loopback.
      hostNetwork: true,

      // Both are needed. The selector says it *may* run on ionos; the
      // toleration says it *is allowed to*, past the edge=true:NoSchedule
      // taint. With only one of the two the pod stays Pending.
      nodeSelector: publicSite,
      tolerations: [edgeToleration],

      // No Service: see the header. MetalLB has no pool for the public zone,
      // so a LoadBalancer here would sit Pending forever, and a ClusterIP
      // would be pointless — traffic arrives from nginx on the node itself.
      service: {
        enabled: false,
      },

      ingressClass: {
        enabled: true,
        // ⚠️ Must be false. The internal Traefik's class is the default one;
        // two defaults means an Ingress with no class is claimed by whichever
        // controller wins, which for a public edge is the wrong way to lose.
        isDefaultClass: false,
        name: publicIngressClass,
      },

      providers: {
        // Only Ingresses that name this class. cert-manager's solver Ingress
        // is the one that matters today.
        kubernetesIngress: {
          ingressClass: publicIngressClass,
          // Nothing to publish — there is no Service to copy an address from,
          // and leaving this on makes Traefik log about a missing one forever.
          publishedService: {
            enabled: false,
          },
        },
        // IngressRoutes must opt in by label. Traefik's CRD provider has no
        // notion of an ingress class on IngressRoute, so a label selector is
        // the filter available — and without it this Traefik would serve every
        // internal IngressRoute in the cluster publicly.
        kubernetesCRD: {
          labelSelector: Object.entries(publicRouteSelector)
            .map(([key, value]) => `${key}=${value}`)
            .join(","),
        },
      },

      ports: {
        // The `web` entrypoint. `port` is the container port and therefore —
        // under hostNetwork — the host port that nginx proxies to.
        //
        // ⚠️ 8000 is duplicated in `hosts/nixos/ionos/public-ingress.nix` as
        // `traefikWeb`. Changing it here alone leaves nginx proxying to a
        // closed port: every ACME challenge 502s and certificates stop
        // renewing about 30 days later, long after the change that caused it.
        web: {
          port: 8000,
          expose: {
            default: false,
          },
          // nginx terminates the client connection and re-originates from
          // loopback, so without this every public client's IP would be
          // recorded as 127.0.0.1 — the same blindness the old DNAT caused,
          // which is what D7 exists to fix.
          forwardedHeaders: {
            trustedIPs: ["127.0.0.1/32", "::1/128"],
          },
        },

        // Not reachable yet: nginx still hands the public :443 to Headscale,
        // and splitting it by SNI is Stage B. The entrypoint is defined so the
        // pod's shape does not change when that lands.
        websecure: {
          expose: {
            default: false,
          },
        },

        traefik: {
          expose: {
            default: false,
          },
        },

        // ⚠️ Moved off the chart's default 9100, which under hostNetwork is a
        // straight port conflict: `prometheus-node-exporter` already runs on
        // ionos with hostNetwork and owns *:9100, so Traefik would fail to
        // bind and crashloop. The chart's own values file warns about this
        // case; it is only a problem because this is the one Traefik that does
        // not get its own network namespace.
        //
        // Kept rather than disabled: renewal for every certificate in the
        // estate now depends on this pod being reachable, so it is the last
        // thing that should be invisible.
        metrics: {
          port: 9101,
          exposedPort: 9101,
          expose: {
            default: false,
          },
        },
      },

      // No dashboard. The internal Traefik has one behind Authentik; a second
      // one on the public edge is an unauthenticated routing table on the
      // internet if the firewall is ever wrong.
      api: {
        dashboard: false,
        insecure: false,
      },
      ingressRoute: {
        dashboard: {
          enabled: false,
        },
      },

      log: {
        level: "INFO",
        format: "json",
      },
      accessLog: {
        enabled: true,
        format: "json",
        fields: {
          defaultMode: "keep",
          headers: {
            defaultMode: "keep",
          },
        },
      },
    },
  },
  { dependsOn: [traefikNamespace] },
);

export { traefikPublic };
