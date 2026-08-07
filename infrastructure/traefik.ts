// Traefik Ingress Controller Configuration
// NOTE: K3s ships with Traefik by default - you must disable it during K3s installation:
// curl -sfL https://get.k3s.io | sh -s - --disable traefik

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { authentikOutpostService } from "../auth/authentik-outpost";
import { authentikNamespace } from "../auth/authentik";
import { lb, winkelSite } from "./sites";

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
    version: "41.1.1",
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
      service: {
        // Pinned, not requested. This address is already load-bearing: both
        // sites' AdGuard rewrites *.mvissing.de to their own ingressVIP, so
        // Winkel clients resolve every hostname here whether or not anything
        // answers. The previous cluster held 192.168.178.10 by allocation
        // order alone, which is why a rebuild broke six DNAT rules on ionos.
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
        },
      },
      // Keep the ingress at the site whose address it announces. A Traefik pod
      // at Brink serving 192.168.178.240 would take every Winkel request
      // across the WAN overlay and back.
      //
      // ⚠️ Brink's own ingressVIP (192.168.1.240) is therefore unserved until
      // Phase 9, which adds the per-site internal Traefik alongside the
      // hostNetwork one on ionos (D7). Brink AdGuard already rewrites
      // *.mvissing.de to it.
      nodeSelector: winkelSite,
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
        },
        websecure: {
          port: 443,
          exposedPort: 443,
          // Enable HTTP/3
          http3: {
            enabled: true,
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
        name: "letsencrypt-prod",
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
