// Traefik Ingress Controller Configuration
// NOTE: K3s ships with Traefik by default - you must disable it during K3s installation:
// curl -sfL https://get.k3s.io | sh -s - --disable traefik

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { authentikOutpostService } from "./authentik-outpost";
import { authentikNamespace } from "./authentik";

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
    version: "37.4.0",
    namespace: traefikNamespace.metadata.name,
    fetchOpts: {
      repo: "https://traefik.github.io/charts",
    },
    values: {
      // Configure Traefik to use LoadBalancer service
      service: {
        type: "LoadBalancer",
        // Request specific IP from MetalLB pool (optional, MetalLB will auto-assign if not specified)
        // loadBalancerIP: "192.168.178.10",
        // Enable dual-stack IPv4+IPv6
        ipFamilyPolicy: "RequireDualStack",
        ipFamilies: ["IPv4", "IPv6"],
      },
      // Logs configuration - JSON format for Loki/Grafana
      logs: {
        general: {
          level: "INFO",
          format: "json",
        },
        access: {
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
        // Traefik dashboard/API port - expose in service for Homepage widget
        traefik: {
          port: 9000,
          exposedPort: 9000,
          expose: {
            default: true,
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
  { dependsOn: [traefikNamespace] }
);

// Authentik Forward Auth Middleware
// Points to the dedicated Authentik outpost service for forward authentication
const authentikMiddleware = new k8s.apiextensions.CustomResource("traefik-authentik-middleware", {
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
}, { dependsOn: [traefik, authentikOutpostService] });

// Certificate for Traefik Internal Dashboard
const dashboardCertificate = new k8s.apiextensions.CustomResource("traefik-cert", {
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
}, { dependsOn: [traefik] });

// IngressRoute for Traefik Internal Dashboard with Authentik Auth
const dashboardIngressRoute = new k8s.apiextensions.CustomResource("traefik-dashboard", {
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
      "gethomepage.dev/widget.url": "http://traefik.traefik.svc.cluster.local:9000",
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
}, { dependsOn: [authentikMiddleware, dashboardCertificate] });

export { traefik, traefikNamespace, authentikMiddleware, dashboardCertificate, dashboardIngressRoute };