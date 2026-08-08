// Traefik Ingress Controller Configuration
// NOTE: K3s ships with Traefik by default - you must disable it during K3s installation:
// curl -sfL https://get.k3s.io | sh -s - --disable traefik

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { authentikOutpostService } from "../auth/authentik-outpost";
import { authentikNamespace } from "../auth/authentik";
import { lb, ZONE_LABEL } from "./sites";
import { activeClusterIssuer } from "./cert-manager";

// Create namespace for Traefik
const traefikNamespace = new k8s.core.v1.Namespace("traefik", {
  metadata: {
    name: "traefik",
  },
});

// Install Traefik using Helm
const traefik = new k8s.helm.v3.Chart(
  "traefik",
  {
    chart: "traefik",
    version: "41.2.0",
    namespace: traefikNamespace.metadata.name,
    fetchOpts: {
      repo: "https://traefik.github.io/charts",
    },
    values: {
      // Configure Traefik to use LoadBalancer service
      //
      // ⚠️ Anything that belongs in the Service's `spec` must go under
      // `service.spec`. The chart's `traefik.service-spec` template renders
      // *only* `.Values.service.spec` (templates/_service.tpl); keys placed
      // directly under `service` that are not in its schema — `type`,
      // `ipFamilyPolicy`, `ipFamilies` — are silently dropped. They are not
      // rejected either, because only the root of values.schema.json sets
      // `additionalProperties: false`.
      // One Deployment, one replica per site, one Service per site.
      //
      // Both addresses are already load-bearing: each site's AdGuard rewrites
      // *.mvissing.de to its own ingressVIP, so clients at both sites resolve
      // every hostname to these whether or not anything answers. The previous
      // cluster held 192.168.178.10 by allocation order alone, which is why a
      // rebuild broke six DNAT rules on ionos.
      service: {
        annotations: {
          "metallb.universe.tf/loadBalancerIPs": lb.traefikWinkel,
        },
        spec: {
          type: "LoadBalancer",
          // Single-stack IPv4. D1 dropped cluster dual-stack — k3s runs
          // --cluster-cidr=10.42.0.0/16 with no IPv6 CIDR, so a dual-stack
          // request cannot be satisfied. Native IPv6 survives as site-to-site
          // transport and public termination at ionos, neither of which is a
          // cluster address family.
          ipFamilyPolicy: "SingleStack",
          ipFamilies: ["IPv4"],
          // ⚠️ Load-bearing, not a tuning knob. MetalLB only announces an
          // address from a node that has a *local* ready endpoint, so with
          // `Local` each site's VIP is announced only by a node at that site
          // which is actually running a Traefik pod. Revert this to `Cluster`
          // and Brink's traffic can be forwarded across the WAN overlay to a
          // Winkel pod — working, but slow and silently cross-site.
          externalTrafficPolicy: "Local",
        },
        // Brink's ingress. Until this existed, 192.168.1.240 resolved for
        // every *.mvissing.de name at Brink and served nothing — which is also
        // what stopped Phase 8's "Authentik survives maxdata" work from
        // actually delivering.
        additionalServices: {
          brink: {
            // ⚠️ Without this the chart emits a *second* Service,
            // `traefik-brink-udp`, because HTTP/3 puts a UDP port on
            // websecure. It would then ask brink-pool for its own address —
            // and with autoAssign disabled it gets none and sits Pending.
            // `single` shares one address across TCP and UDP, matching the
            // main Service, which defaults to true for the same reason.
            single: true,
            annotations: {
              "metallb.universe.tf/loadBalancerIPs": lb.traefikBrink,
            },
            spec: {
              type: "LoadBalancer",
              ipFamilyPolicy: "SingleStack",
              ipFamilies: ["IPv4"],
              externalTrafficPolicy: "Local",
            },
          },
        },
      },
      // Two replicas so each site has one. `externalTrafficPolicy: Local`
      // makes this a correctness requirement rather than redundancy: a site
      // with no local pod gets no announcement and no ingress at all.
      deployment: {
        replicas: 2,
      },
      // Spread across sites, not merely across nodes.
      //
      // `DoNotSchedule` rather than `ScheduleAnyway`: both replicas landing at
      // Winkel is not a degraded state to tolerate, it is Brink having no
      // ingress. Better to leave a replica Pending and visible.
      //
      // ionos excludes itself — it holds the edge=true:NoSchedule taint and
      // this chart adds no toleration for it.
      topologySpreadConstraints: [
        {
          maxSkew: 1,
          topologyKey: ZONE_LABEL,
          whenUnsatisfiable: "DoNotSchedule",
          labelSelector: {
            matchLabels: {
              "app.kubernetes.io/name": "traefik",
              "app.kubernetes.io/instance": "traefik-traefik",
            },
          },
        },
      ],
      // Logs configuration - JSON format for Loki/Grafana
      //
      // ⚠️ These were a single `logs: { general, access }` block, which this
      // chart version rejects outright — the root of its values schema sets
      // `additionalProperties: false`, so an unknown key fails the render
      // rather than being ignored. Split into `log` and `accessLog`.
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
      // Enable Traefik dashboard API
      api: {
        dashboard: true,
        insecure: true, // Allow internal access on port 9000 for Homepage widget
      },
      // Configure entry points
      ports: {
        web: {
          port: 80,
          exposedPort: 80,
          // ⚠️ Keyed by *service* name, not a boolean. `default` is the main
          // Service and `brink` is the additionalService above; a port missing
          // from this map is simply absent from that Service, and the chart
          // fails the render outright if a Service ends up with no ports.
          expose: {
            default: true,
            brink: true,
          },
        },
        websecure: {
          port: 443,
          exposedPort: 443,
          // Enable HTTP/3
          http3: {
            enabled: true,
          },
          expose: {
            default: true,
            brink: true,
          },
        },
        // Traefik dashboard/API port.
        //
        // ⚠️ `expose.default` is false on purpose. It used to be true, which
        // put the **unauthenticated** API on the LoadBalancer address at
        // :9000 — reachable from the whole LAN, and bypassing the
        // Authentik-protected traefik.mvissing.de route entirely. Anyone on
        // the network could read the full routing table and every service's
        // internal address without a login.
        //
        // The port stays open on the pod so the Homepage widget can still
        // reach it, but only through the ClusterIP service defined below,
        // which has no presence outside the cluster.
        traefik: {
          port: 9000,
          exposedPort: 9000,
          expose: {
            default: false,
          },
        },
      },
      // Enable dashboard API
      ingressRoute: {
        dashboard: {
          enabled: false, // We'll create custom IngressRoute with auth
        },
      },
      // Global redirect from HTTP to HTTPS using command-line arguments
      additionalArguments: [
        "--entrypoints.web.http.redirections.entryPoint.to=websecure",
        "--entrypoints.web.http.redirections.entryPoint.scheme=https",
        "--entrypoints.web.http.redirections.entrypoint.permanent=true",
        "--api.insecure=true", // Enable API on port 9000 for Homepage widget
      ],
    },
  },
  { dependsOn: [traefikNamespace] },
);

// ClusterIP service for the Traefik API, for in-cluster consumers only.
//
// `api.insecure: true` serves the API without authentication, which is
// tolerable on a ClusterIP and was not on a LoadBalancer. Homepage's widget is
// the only consumer; the human-facing dashboard goes through
// traefik.mvissing.de, which is behind Authentik forward auth.
const traefikApiService = new k8s.core.v1.Service(
  "traefik-api",
  {
    metadata: {
      name: "traefik-api",
      namespace: traefikNamespace.metadata.name,
    },
    spec: {
      type: "ClusterIP",
      selector: {
        "app.kubernetes.io/name": "traefik",
        "app.kubernetes.io/instance": "traefik-traefik",
      },
      ports: [
        {
          name: "traefik",
          port: 9000,
          targetPort: 9000,
          protocol: "TCP",
        },
      ],
    },
  },
  { dependsOn: [traefik] },
);

// Authentik Forward Auth Middleware
// Points to the dedicated Authentik outpost service for forward authentication
const authentikMiddleware = new k8s.apiextensions.CustomResource(
  "traefik-authentik-middleware",
  {
    apiVersion: "traefik.io/v1alpha1",
    kind: "Middleware",
    metadata: {
      name: "authentik",
      namespace: traefikNamespace.metadata.name,
    },
    spec: {
      forwardAuth: {
        // MUST use public URL (not internal cluster URL) for domain-level forward auth
        // This ensures browser cookies are properly forwarded through the ingress
        address: "https://auth.mvissing.de/outpost.goauthentik.io/auth/traefik",
        trustForwardHeader: true,
        // Forward these headers to Authentik so it can redirect back to the original URL
        // Cookie is essential for Authentik to verify existing sessions
        authRequestHeaders: [
          "Cookie",
          "X-Forwarded-Proto",
          "X-Forwarded-Host",
          "X-Forwarded-Uri",
          "X-Forwarded-For",
        ],
        authResponseHeaders: [
          "X-authentik-username",
          "X-authentik-groups",
          "X-authentik-email",
          "X-authentik-name",
          "X-authentik-uid",
        ],
        authResponseHeadersRegex: "^X-authentik-",
      },
    },
  },
  { dependsOn: [traefik, authentikOutpostService] },
);

// Certificate for Traefik Internal Dashboard
const dashboardCertificate = new k8s.apiextensions.CustomResource(
  "traefik-cert",
  {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: {
      name: "traefik-dashboard-tls",
      namespace: traefikNamespace.metadata.name,
    },
    spec: {
      secretName: "traefik-dashboard-tls",
      dnsNames: ["traefik.mvissing.de"],
      issuerRef: {
        name: activeClusterIssuer,
        kind: "ClusterIssuer",
        group: "cert-manager.io",
      },
    },
  },
  { dependsOn: [traefik] },
);

// IngressRoute for Traefik Internal Dashboard with Authentik Auth
const dashboardIngressRoute = new k8s.apiextensions.CustomResource(
  "traefik-dashboard",
  {
    apiVersion: "traefik.io/v1alpha1",
    kind: "IngressRoute",
    metadata: {
      name: "traefik-dashboard",
      namespace: traefikNamespace.metadata.name,
      annotations: {
        // Homepage dashboard discovery
        "gethomepage.dev/enabled": "true",
        "gethomepage.dev/name": "Traefik",
        "gethomepage.dev/description": "Ingress Controller",
        "gethomepage.dev/group": "Infrastructure",
        "gethomepage.dev/icon": "traefik",
        "gethomepage.dev/href": "https://traefik.mvissing.de",
        "gethomepage.dev/pod-selector": "app.kubernetes.io/name=traefik",
        // Traefik widget
        "gethomepage.dev/widget.type": "traefik",
        // The API is no longer on the LoadBalancer service; this is the
        // in-cluster-only ClusterIP that replaced that exposure.
        "gethomepage.dev/widget.url":
          "http://traefik-api.traefik.svc.cluster.local:9000",
      },
    },
    spec: {
      entryPoints: ["websecure"],
      routes: [
        {
          match: "Host(`traefik.mvissing.de`)",
          kind: "Rule",
          middlewares: [
            {
              name: authentikMiddleware.metadata.name,
              namespace: traefikNamespace.metadata.name,
            },
          ],
          services: [
            {
              name: "api@internal",
              kind: "TraefikService",
            },
          ],
        },
      ],
      tls: {
        secretName: "traefik-dashboard-tls",
      },
    },
  },
  { dependsOn: [authentikMiddleware, dashboardCertificate] },
);

export {
  traefik,
  traefikNamespace,
  traefikApiService,
  authentikMiddleware,
  dashboardCertificate,
  dashboardIngressRoute,
};
