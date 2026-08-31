// Trip Plan View — static SPA for the 2026 Alpine roadtrip (day-by-day map).
//
// Built from the private `MaxMac99/vacation` repo: Vite + React + Leaflet,
// served by nginx, no backend, no database, no volumes, no state. The image
// is delivered as a **private** GHCR package (the source repo is private, so
// packages pushed from its CI are private by default), which is why this file
// needs an imagePullSecret and why Renovate cannot bump the tag — the Mend app
// has no `packages:read` on private packages, so version bumps here are
// manual, one-line edits.
//
// ⚠️ The gate is **server-side forward auth on both Ingresses**, not anything
// in the app. The SPA ships without auth code; the Authentik outpost answers
// Traefik before nginx is ever consulted, so `curl https://trip.mvissing.de/`
// gets a 302, never the bundle. Keeping the gate in the app instead would be
// cosmetic for a static site: the trip data ships inside the JS, so any
// client able to reach the host would have it regardless of login.
//
// Published on **both** Traefiks — this is the first app on the public edge
// after Authentik itself. The dual-Ingress pattern follows authentik.ts; the
// two Traefiks are not interchangeable (see CLAUDE.md / traefik-public.ts):
// split-horizon DNS serves the site VIPs from inside the homes, public DNS
// serves ionos from everywhere else. Losing either path must not take the
// page down — that is the point of a travel app.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import { traefikNamespace } from "../infrastructure/traefik";
import {
  publicIngressClass,
  publicRouteSelector,
  ARCH_LABEL,
  ZONE_LABEL,
} from "../infrastructure/sites";
import { authentikOutpostService } from "../auth/authentik-outpost";

const config = new pulumi.Config();

// Classic PAT with `read:packages`. Packages pushed from a private repo are
// private, and the cluster has no identity a private package would trust.
// Set with: pulumi config set --secret tripRegistryPullToken <token>
const registryPullToken = config.requireSecret("tripRegistryPullToken");

// CARTO basemap key. Vite bakes it into the JS at build time, so the image is
// built with the placeholder `__CARTO_API_KEY__` and the container entrypoint
// rewrites the bundle at start with this value. If the Secret is ever empty
// the script falls back to the free CARTO tier instead of shipping a bogus
// key. (Either way the key is visible in the browser — it is a basemap key in
// a client-side app, not a credential; the Secret keeps it out of the image
// and out of git.)
// Set with: pulumi config set --secret tripCartoApiKey <key>
const cartoApiKey = config.requireSecret("tripCartoApiKey");

const namespace = new k8s.core.v1.Namespace("trip", {
  metadata: {
    name: "trip",
  },
});

// Pull secret for the private GHCR package. `auth` is base64("user:token")
// — the form kubelet actually reads.
const registryPullSecret = new k8s.core.v1.Secret("trip-registry-pull", {
  metadata: {
    name: "trip-registry-pull",
    namespace: namespace.metadata.name,
  },
  type: "kubernetes.io/dockerconfigjson",
  stringData: {
    ".dockerconfigjson": registryPullToken.apply((token) =>
      Buffer.from(
        JSON.stringify({
          auths: {
            "ghcr.io": {
              username: "MaxMac99",
              password: token,
              auth: Buffer.from(`MaxMac99:${token}`).toString("base64"),
            },
          },
        }),
      ).toString("utf8"),
    ),
  },
});

// Runtime config for the SPA entrypoint. See the header comment: baked
// placeholder in the image, real value substituted at container start.
const tripSecret = new k8s.core.v1.Secret("trip-secrets", {
  metadata: {
    name: "trip-secrets",
    namespace: namespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    VITE_CARTO_API_KEY: cartoApiKey,
  },
});

const tripDeployment = new k8s.apps.v1.Deployment(
  "trip",
  {
    metadata: {
      name: "trip",
      namespace: namespace.metadata.name,
      labels: {
        app: "trip",
      },
    },
    spec: {
      // Stateless by construction, so two replicas across the two sites are
      // free. amd64 only: winkel-pi is the estate's only arm64 node, and this
      // image is built single-platform for that reason.
      replicas: 2,
      selector: {
        matchLabels: {
          app: "trip",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "trip",
          },
        },
        spec: {
          nodeSelector: {
            [ARCH_LABEL]: "amd64",
          },
          // Preferred, not required: one pod per site when both sites are up,
          // two on one site when one is dark. `DoNotSchedule` would instead
          // leave the second replica Pending, which for a static nginx is the
          // wrong trade.
          topologySpreadConstraints: [
            {
              maxSkew: 1,
              topologyKey: ZONE_LABEL,
              whenUnsatisfiable: "ScheduleAnyway",
              labelSelector: {
                matchLabels: {
                  app: "trip",
                },
              },
            },
          ],
          imagePullSecrets: [
            {
              name: registryPullSecret.metadata.name,
            },
          ],
          containers: [
            {
              name: "trip",
              // Renovate-format one-liner, bumped by hand (see header).
              image: "ghcr.io/maxmac99/vacation-plan-view:0.1.0",
              ports: [
                {
                  containerPort: 8080,
                  name: "http",
                  protocol: "TCP",
                },
              ],
              env: [
                {
                  name: "VITE_CARTO_API_KEY",
                  valueFrom: {
                    secretKeyRef: {
                      name: tripSecret.metadata.name,
                      key: "VITE_CARTO_API_KEY",
                    },
                  },
                },
              ],
              livenessProbe: {
                httpGet: {
                  path: "/",
                  port: 8080,
                },
                initialDelaySeconds: 10,
                periodSeconds: 30,
                timeoutSeconds: 5,
                failureThreshold: 5,
              },
              readinessProbe: {
                httpGet: {
                  path: "/",
                  port: 8080,
                },
                initialDelaySeconds: 5,
                periodSeconds: 10,
                timeoutSeconds: 3,
                failureThreshold: 10,
              },
              resources: {
                requests: {
                  cpu: "10m",
                  memory: "32Mi",
                },
                limits: {
                  cpu: "100m",
                  memory: "64Mi",
                },
              },
            },
          ],
        },
      },
    },
  },
  { dependsOn: [namespace, registryPullSecret, tripSecret] },
);

// ClusterIP for the two Ingresses to target.
const tripService = new k8s.core.v1.Service("trip-service", {
  metadata: {
    name: "trip",
    namespace: namespace.metadata.name,
  },
  spec: {
    type: "ClusterIP",
    selector: {
      app: "trip",
    },
    ports: [
      {
        port: 80,
        targetPort: 8080,
        name: "http",
        protocol: "TCP",
      },
    ],
  },
});

// Forward-auth middleware for the **public** Traefik.
//
// ⚠️ This is a second middleware, not a label on the existing one: the
// internal `authentik` middleware in traefik.ts carries no labels and
// traefik-public filters every CRD it serves by `ingress=public`
// (infrastructure/traefik-public.ts), so the existing middleware is invisible
// to the public edge by design. Same address as its sibling — the outpost's
// **in-cluster Service**, which works from ionos because ionos is a cluster
// node. Never the public hostname: that hairpins through a MetalLB VIP and
// fails with `remote error: tls: internal error` (traefik.ts).
const authentikPublicMiddleware = new k8s.apiextensions.CustomResource(
  "traefik-authentik-public-middleware",
  {
    apiVersion: "traefik.io/v1alpha1",
    kind: "Middleware",
    metadata: {
      name: "authentik-public",
      namespace: traefikNamespace.metadata.name,
      labels: publicRouteSelector,
    },
    spec: {
      forwardAuth: {
        address: pulumi.interpolate`http://${authentikOutpostService.metadata.name}.authentik.svc.cluster.local:9000/outpost.goauthentik.io/auth/traefik`,
        trustForwardHeader: true,
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
  { dependsOn: [traefikNamespace, authentikOutpostService] },
);

const tripIngressRules = [
  {
    host: "trip.mvissing.de",
    http: {
      paths: [
        {
          path: "/",
          pathType: "Prefix" as const,
          backend: {
            service: {
              name: tripService.metadata.name,
              port: {
                number: 80,
              },
            },
          },
        },
      ],
    },
  },
];

// Internal Ingress — the site-local Traefik. This copy owns certificate
// issuance (see authentik.ts for why exactly one Ingress may carry the
// issuer annotation against a shared TLS Secret).
const tripIngress = new k8s.networking.v1.Ingress("trip-ingress", {
  metadata: {
    name: "trip",
    namespace: namespace.metadata.name,
    annotations: {
      "pulumi.com/skipAwait": "true",
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "traefik.ingress.kubernetes.io/router.middlewares":
        "traefik-authentik@kubernetescrd",
      "cert-manager.io/cluster-issuer": activeClusterIssuer,

      "traefik.ingress.kubernetes.io/redirect-entry-point": "websecure",
      "traefik.ingress.kubernetes.io/redirect-permanent": "true",

      // Homepage dashboard discovery
      "gethomepage.dev/enabled": "true",
      "gethomepage.dev/name": "Trip Plan",
      "gethomepage.dev/description": "Alpine Roadtrip 2026",
      "gethomepage.dev/group": "Home",
      "gethomepage.dev/icon": "mdi-map",
      "gethomepage.dev/pod-selector": "app=trip",
      "gethomepage.dev/href": "https://trip.mvissing.de",
    },
  },
  spec: {
    ingressClassName: "traefik",
    rules: tripIngressRules,
    tls: [
      {
        secretName: "trip-tls",
        hosts: ["trip.mvissing.de"],
      },
    ],
  },
});

// Public Ingress — the internet-facing Traefik on ionos.
//
// ⚠️ Three things deliberately *not* copied from the internal Ingress
// (same reasoning as authentik.ts, which this mirrors):
//
//   - `cert-manager.io/cluster-issuer`. The internal Ingress owns issuance;
//     a second issuer annotation here would create a second Certificate for
//     trip.mvissing.de contending for the same `trip-tls` Secret.
//   - the HTTP→HTTPS redirect. The public Traefik's `web` entrypoint on :80
//     serves cert-manager's HTTP-01 solver Ingresses for *every* certificate
//     in the estate; a redirect on a public host name would bounce ACME
//     challenges and stop renewal estate-wide about 30 days later. Plain-HTTP
//     callers get a 404, which is the cheap half of that trade.
//   - the `gethomepage.dev/*` annotations, which would put a duplicate tile
//     on the dashboard.
//
// What it *does* add is the public forward-auth middleware — without it this
// host would be the one thing on the public edge serving the bundle to
// anyone, since the gate is the only thing standing between the internet and
// the trip data.
const tripPublicIngress = new k8s.networking.v1.Ingress("trip-public-ingress", {
  metadata: {
    name: "trip-public",
    namespace: namespace.metadata.name,
    annotations: {
      // Required on the public edge even where the internal Ingress does
      // without it: traefik-public has no Service and never writes an
      // address into status.loadBalancer, so Pulumi would await it forever
      // (see authentikPublicIngress in auth/authentik.ts).
      "pulumi.com/skipAwait": "true",
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "traefik.ingress.kubernetes.io/router.middlewares":
        "traefik-authentik-public@kubernetescrd",
    },
  },
  spec: {
    ingressClassName: publicIngressClass,
    rules: tripIngressRules,
    tls: [
      {
        secretName: "trip-tls",
        hosts: ["trip.mvissing.de"],
      },
    ],
  },
});

export {
  namespace as tripNamespace,
  tripDeployment,
  tripService,
  tripIngress,
  tripPublicIngress,
  authentikPublicMiddleware,
};

// Setup:
//
// 1. Build and publish the image (vacation repo):
//      git tag v0.1.0 && git push origin v0.1.0
//    The release workflow pushes ghcr.io/maxmac99/vacation-plan-view:0.1.0
//    (private — verify once on github.com/users/MaxMac99/packages).
//    If the tag in this file changes, bump the Deployment image above —
//    Renovate cannot see private packages, so nothing else will.
//
// 2. Secrets:
//      pulumi config set --secret tripRegistryPullToken <classic PAT, read:packages>
//      pulumi config set --secret tripCartoApiKey <CARTO key>
//
// 3. Authentik (UI, not API — same recipe as homepage.ts):
//    a. Applications → Providers → Create → Proxy Provider
//       - Name: Trip
//       - Authorization flow: default-provider-authorization-implicit-consent
//       - Type: Forward auth (domain level)
//       - Cookie domain: .mvissing.de (leading dot — one login covers the
//         whole estate, and the browser holds the session, not this app)
//       - External host: https://trip.mvissing.de
//       (If the existing "Forward Auth - Domain Level" provider already
//       covers new hosts, bind the Application to it instead.)
//    b. Applications → Applications → Create
//       - Name: Trip, Slug: trip, Provider: from (a)
//       - Launch URL: https://trip.mvissing.de
//    c. Applications → Outposts → authentik-outpost → add the Trip
//       application
//    d. Bind the family group (or equivalent) to the Application as policy —
//       that binding is the authorization; without it every authenticated
//       estate user gets in.
//
// 4. DNS:
//    - Public (IONOS): A trip.mvissing.de → 212.132.82.102 (the ionos nginx
//      splits :443 by SNI into traefik-public; :80 must stay untouched — the
//      ACME solver path for every certificate in the estate runs through it).
//    - Split-horizon (`setup` repo, modules/system/site-dns.nix): AdGuard
//      rewrite at both sites, brink → 192.168.1.240, winkel → 192.168.178.240.
//
// 5. pulumi up (via PR → merge → CI), then verify:
//    - curl https://trip.mvissing.de/ → 302 to Authentik (never 200)
//    - browser login → trip renders; from LAN the site VIP serves it
//    - kubectl get pods -n trip (2/2 Ready, spread across zones)
