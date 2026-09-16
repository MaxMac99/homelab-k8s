// Meals — "Yet Another Meal Planner" (github.com/marco308/meals).
//
// A meal options planner: a recipe library with URL ingest, pools of meal
// options instead of a fixed Mon–Sun grid, and an aisle-sorted shopping list
// with full provenance. No built-in LLM — the AI access layer (REST API, the
// built-in MCP endpoint at /mcp, and the self-published /skill + /prompt-pack)
// is meant to be driven by an external assistant; the household uses a ChatGPT
// Custom GPT against /openapi.json with a personal API token.
//
// Single container (`ghcr.io/marco308/meals`): API, web client, skill and MCP
// endpoint are all served by the one image on port 8000. Pointed at Postgres
// via DATABASE_URL, it is **stateless** — no volume, no SQLite under /data.
//
// ⚠️ The auth split is load-bearing, and it is not the trip.ts pattern:
//
//   - `/app` (the web client) sits behind **Authentik forward auth**, because
//     the user asked for the UI to be gated and a browser can do the redirect.
//   - **Everything else stays on the app's own auth** — the API, /mcp, the iOS
//     app and the Custom GPT all authenticate with `Authorization: Bearer
//     meals_…` personal access tokens. Putting forward auth on those paths
//     would break every non-browser client: they cannot complete an OAuth
//     redirect, so the outpost would answer them with a 302 instead of the
//     API. The app's own auth is designed to be the gate on an internet-facing
//     deployment (bcrypt + opaque tokens, rate-limited auth endpoints, and
//     auth is mandatory everywhere except /healthz).
//
//   So the internal edge carries three Ingresses — `/` (API + root landing),
//   `/app` (forward auth), `/outpost.goauthentik.io` (the forward-auth
//   callback, routed without it, same bypass as trip.ts) — and the public edge
//   mirrors all three, with `/app` behind the public middleware.
//
// ⚠️ `REGISTRATION_ENABLED` is `"true"` **only until the first account
// exists**, because this deployment is on the public edge and registration
// creates a household of one's own. Flip it to `"false"` as soon as the
// account is registered (step 2 at the bottom) — the flag closes the door
// without locking out existing accounts.
//
// Placement: pinned to **Brink**, alongside the shared `postgres` cluster that
// holds its database (databases/postgresql.ts) — one site, no HA wanted, and
// the DB never takes a cross-site hop. amd64 only: winkel-pi is the estate's
// only arm64 node.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import {
  ARCH_LABEL,
  brinkSite,
  publicIngressClass,
} from "../infrastructure/sites";
import { authentikOutpostService } from "../auth/authentik-outpost";
import {
  mealsDbPassword,
  postgresqlClusterName,
  postgresqlHost,
  postgresqlNamespace,
} from "../databases/postgresql";

const namespace = new k8s.core.v1.Namespace("meals", {
  metadata: {
    name: "meals",
  },
});

// The database lives on the shared Brink cluster — a declarative Database CR,
// same shape as homeassistant's (apps/homeassistant.ts). CNPG creates the
// database owned by the `meals` role declared in databases/postgresql.ts.
const mealsDatabase = new k8s.apiextensions.CustomResource("meals-database", {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Database",
  metadata: {
    name: "meals-db",
    namespace: postgresqlNamespace,
  },
  spec: {
    name: "meals",
    owner: "meals",
    cluster: {
      name: postgresqlClusterName,
    },
  },
});

// Credentials in the app namespace. The Reflector-mirrored copy from
// databases/postgresql.ts exists, but the app reads its own — same
// belt-and-braces as homeassistant.ts ("Not relying on Reflector due to
// reliability issues"). The backup CronJob in `database` mounts the original.
const mealsDbSecret = new k8s.core.v1.Secret("meals-db-secret", {
  metadata: {
    name: "postgres-meals",
    namespace: namespace.metadata.name,
  },
  type: "kubernetes.io/basic-auth",
  stringData: {
    username: "meals",
    password: mealsDbPassword,
  },
});

// Full asyncpg connection string as one secret key — the app takes DATABASE_URL
// verbatim, and a composed value keeps the password out of the pod spec.
const mealsConfig = new k8s.core.v1.Secret("meals-config", {
  metadata: {
    name: "meals-config",
    namespace: namespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    DATABASE_URL: pulumi.interpolate`postgresql+asyncpg://meals:${mealsDbPassword}@${postgresqlHost}:5432/meals`,
  },
});

const mealsDeployment = new k8s.apps.v1.Deployment(
  "meals",
  {
    metadata: {
      name: "meals",
      namespace: namespace.metadata.name,
      labels: {
        app: "meals",
      },
    },
    spec: {
      // Stateless with Postgres, and HA is explicitly not wanted — one replica.
      replicas: 1,
      selector: {
        matchLabels: {
          app: "meals",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "meals",
          },
        },
        spec: {
          nodeSelector: {
            [ARCH_LABEL]: "amd64",
            ...brinkSite,
          },
          containers: [
            {
              name: "meals",
              // Renovate-format one-liner; releases publish per-version tags.
              image: "ghcr.io/marco308/meals:1.6.1",
              ports: [
                {
                  containerPort: 8000,
                  name: "http",
                  protocol: "TCP",
                },
              ],
              env: [
                {
                  name: "DATABASE_URL",
                  valueFrom: {
                    secretKeyRef: {
                      name: mealsConfig.metadata.name,
                      key: "DATABASE_URL",
                    },
                  },
                },
                {
                  // JSON logs to stdout, so Loki reads one record per line.
                  name: "ENVIRONMENT",
                  value: "production",
                },
                {
                  // Public edge — registration closed. The account exists
                  // (registered 2026-09-15); the flag honours existing
                  // accounts and tokens, it only stops new households.
                  name: "REGISTRATION_ENABLED",
                  value: "false",
                },
              ],
              livenessProbe: {
                httpGet: {
                  // /healthz is the one unauthenticated path — designed to be
                  // probed, and it touches no database.
                  path: "/healthz",
                  port: 8000,
                },
                initialDelaySeconds: 15,
                periodSeconds: 30,
                timeoutSeconds: 5,
                failureThreshold: 5,
              },
              readinessProbe: {
                httpGet: {
                  path: "/healthz",
                  port: 8000,
                },
                // Alembic migrates the schema on boot; give it room.
                initialDelaySeconds: 5,
                periodSeconds: 10,
                timeoutSeconds: 3,
                failureThreshold: 12,
              },
              resources: {
                requests: {
                  cpu: "100m",
                  memory: "128Mi",
                },
                limits: {
                  cpu: "500m",
                  memory: "512Mi",
                },
              },
            },
          ],
        },
      },
    },
  },
  { dependsOn: [namespace, mealsDatabase, mealsDbSecret, mealsConfig] },
);

const mealsService = new k8s.core.v1.Service("meals-service", {
  metadata: {
    name: "meals",
    namespace: namespace.metadata.name,
  },
  spec: {
    type: "ClusterIP",
    selector: {
      app: "meals",
    },
    ports: [
      {
        port: 80,
        targetPort: 8000,
        name: "http",
        protocol: "TCP",
      },
    ],
  },
});

// ExternalName alias for the outpost, so the callback-path Ingresses below can
// reach it from this namespace — a standard Ingress backend only resolves
// Services in its own namespace, and cross-namespace service references are
// not enabled on either edge. Same shape as trip.ts.
const outpostAliasService = new k8s.core.v1.Service("meals-outpost-alias", {
  metadata: {
    name: "meals-outpost",
    namespace: namespace.metadata.name,
  },
  spec: {
    type: "ExternalName",
    externalName: pulumi.interpolate`${authentikOutpostService.metadata.name}.authentik.svc.cluster.local`,
    ports: [
      {
        port: 9000,
        targetPort: 9000,
        name: "http",
        protocol: "TCP",
      },
    ],
  },
});

const mealsHost = "meals.mvissing.de";

// Three rule sets, shared between the two edges so they cannot drift:
//
//   - `/`   — the API, the root landing, /mcp, /docs, /openapi.json. The
//             app's own bearer auth is the gate (see the header comment for
//             why forward auth must not cover these).
//   - `/app` — the web client, behind forward auth.
//   - `/outpost.goauthentik.io` — the forward-auth OAuth callback and
//             sign-out, routed to the outpost **without** the middleware:
//             relaying the callback through forward auth eats the outpost's
//             Set-Cookie/redirect response and the login loops forever
//             (trip.ts). Traefik's rule-length priority makes the longer
//             prefixes win over `/`.
const mealsRootRules = [
  {
    host: mealsHost,
    http: {
      paths: [
        {
          path: "/",
          pathType: "Prefix" as const,
          backend: {
            service: {
              name: mealsService.metadata.name,
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

const mealsAppRules = [
  {
    host: mealsHost,
    http: {
      paths: [
        {
          path: "/app",
          pathType: "Prefix" as const,
          backend: {
            service: {
              name: mealsService.metadata.name,
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

const mealsOutpostRules = [
  {
    host: mealsHost,
    http: {
      paths: [
        {
          path: "/outpost.goauthentik.io",
          pathType: "Prefix" as const,
          backend: {
            service: {
              name: outpostAliasService.metadata.name,
              port: {
                number: 9000,
              },
            },
          },
        },
      ],
    },
  },
];

// Internal Ingress — the site-local Traefik. This copy owns certificate
// issuance (exactly one Ingress may carry the issuer annotation against the
// shared TLS Secret — see authentik.ts).
const mealsIngress = new k8s.networking.v1.Ingress("meals-ingress", {
  metadata: {
    name: "meals",
    namespace: namespace.metadata.name,
    annotations: {
      "pulumi.com/skipAwait": "true",
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "cert-manager.io/cluster-issuer": activeClusterIssuer,

      "traefik.ingress.kubernetes.io/redirect-entry-point": "websecure",
      "traefik.ingress.kubernetes.io/redirect-permanent": "true",

      // Homepage dashboard discovery
      "gethomepage.dev/enabled": "true",
      "gethomepage.dev/name": "Meals",
      "gethomepage.dev/description": "Meal Planner & Einkaufsliste",
      "gethomepage.dev/group": "Home",
      "gethomepage.dev/icon": "mdi-silverware-fork-knife",
      "gethomepage.dev/pod-selector": "app=meals",
      "gethomepage.dev/href": "https://meals.mvissing.de",
    },
  },
  spec: {
    ingressClassName: "traefik",
    rules: mealsRootRules,
    tls: [
      {
        secretName: "meals-tls",
        hosts: [mealsHost],
      },
    ],
  },
});

// Internal /app Ingress — behind the shared internal forward-auth middleware
// (`<namespace>-<name>@kubernetescrd`: the `authentik` middleware in the
// traefik namespace, infrastructure/traefik.ts).
const mealsAppIngress = new k8s.networking.v1.Ingress("meals-app-ingress", {
  metadata: {
    name: "meals-app",
    namespace: namespace.metadata.name,
    annotations: {
      "pulumi.com/skipAwait": "true",
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "traefik.ingress.kubernetes.io/router.middlewares":
        "traefik-authentik@kubernetescrd",

      "traefik.ingress.kubernetes.io/redirect-entry-point": "websecure",
      "traefik.ingress.kubernetes.io/redirect-permanent": "true",
    },
  },
  spec: {
    ingressClassName: "traefik",
    rules: mealsAppRules,
    tls: [
      {
        secretName: "meals-tls",
        hosts: [mealsHost],
      },
    ],
  },
});

// Internal outpost-path Ingress — routes the single-app OAuth callback and
// sign-out paths to the outpost **without** forward auth. Same TLS Secret so
// the browser sees one certificate across the whole host.
const mealsOutpostIngress = new k8s.networking.v1.Ingress(
  "meals-outpost-ingress",
  {
    metadata: {
      name: "meals-outpost",
      namespace: namespace.metadata.name,
      annotations: {
        "pulumi.com/skipAwait": "true",
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",

        "traefik.ingress.kubernetes.io/redirect-entry-point": "websecure",
        "traefik.ingress.kubernetes.io/redirect-permanent": "true",
      },
    },
    spec: {
      ingressClassName: "traefik",
      rules: mealsOutpostRules,
      tls: [
        {
          secretName: "meals-tls",
          hosts: [mealsHost],
        },
      ],
    },
  },
);

// Public Ingress — the internet-facing Traefik on ionos. Split-horizon DNS
// serves the site VIPs from inside the homes; public DNS serves ionos from
// everywhere else, which is what "von überall erreichbar" is built on.
//
// The annotations deliberately *not* copied from the internal Ingress (same
// reasoning as trip.ts / authentik.ts):
//
//   - `cert-manager.io/cluster-issuer`. The internal Ingress owns issuance; a
//     second one here would create a second Certificate contending for the
//     same `meals-tls` Secret.
//   - the HTTP→HTTPS redirect. The public Traefik's :80 entrypoint serves
//     cert-manager's HTTP-01 solver Ingresses for every certificate in the
//     estate; a redirect on a public host name would bounce ACME challenges
//     and stop renewal estate-wide ~30 days later.
//   - the `gethomepage.dev/*` annotations, which would duplicate the tile.
const mealsPublicIngress = new k8s.networking.v1.Ingress(
  "meals-public-ingress",
  {
    metadata: {
      name: "meals-public",
      namespace: namespace.metadata.name,
      annotations: {
        // Required on the public edge: traefik-public has no Service and never
        // writes an address into status.loadBalancer, so Pulumi would await it
        // forever (see trip.ts).
        "pulumi.com/skipAwait": "true",
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      },
    },
    spec: {
      ingressClassName: publicIngressClass,
      rules: mealsRootRules,
      tls: [
        {
          secretName: "meals-tls",
          hosts: [mealsHost],
        },
      ],
    },
  },
);

// Public /app Ingress — the trip.ts-created public forward-auth middleware
// (`authentik-public` in the traefik namespace, labelled ingress=public so
// traefik-public can see it; apps/trip.ts). The API paths on the public edge
// stay on the app's own auth — the iOS app and the Custom GPT arrive here.
const mealsPublicAppIngress = new k8s.networking.v1.Ingress(
  "meals-public-app-ingress",
  {
    metadata: {
      name: "meals-public-app",
      namespace: namespace.metadata.name,
      annotations: {
        "pulumi.com/skipAwait": "true",
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
        "traefik.ingress.kubernetes.io/router.middlewares":
          "traefik-authentik-public@kubernetescrd",
      },
    },
    spec: {
      ingressClassName: publicIngressClass,
      rules: mealsAppRules,
      tls: [
        {
          secretName: "meals-tls",
          hosts: [mealsHost],
        },
      ],
    },
  },
);

// Public outpost-path Ingress — the ionos half of the callback route. The
// callback can arrive on either edge, so both need the outpost path.
const mealsPublicOutpostIngress = new k8s.networking.v1.Ingress(
  "meals-public-outpost-ingress",
  {
    metadata: {
      name: "meals-public-outpost",
      namespace: namespace.metadata.name,
      annotations: {
        "pulumi.com/skipAwait": "true",
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      },
    },
    spec: {
      ingressClassName: publicIngressClass,
      rules: mealsOutpostRules,
      tls: [
        {
          secretName: "meals-tls",
          hosts: [mealsHost],
        },
      ],
    },
  },
);

export {
  namespace as mealsNamespace,
  mealsDeployment,
  mealsService,
  mealsIngress,
  mealsAppIngress,
  mealsOutpostIngress,
  mealsPublicIngress,
  mealsPublicAppIngress,
  mealsPublicOutpostIngress,
  outpostAliasService as mealsOutpostAliasService,
};

// Setup:
//
// 1. Deploy: pulumi up (via PR → merge → CI). The schema migrates itself on
//    boot; wait for the pod to be Ready.
//
// 2. Register the account at https://meals.mvissing.de — it creates the
//    household. **Then flip REGISTRATION_ENABLED to "false" in this file and
//    deploy again.** The deployment is on the public edge; the flag closes
//    registration while honouring existing accounts and tokens.
//
// 3. Mint a personal API token: web app menu → Settings → AI access (or
//    POST /auth/tokens). This token is what the iOS app and the Custom GPT
//    send as `Authorization: Bearer meals_…`.
//
// 4. Authentik (UI, not API — same recipe as trip.ts):
//    a. Applications → Providers → Create → Proxy Provider
//       - Name: Meals
//       - Authorization flow: default-provider-authorization-implicit-consent
//       - Type: Forward auth (single application)
//       - External host: https://meals.mvissing.de
//    b. Applications → Applications → Create
//       - Name: Meals, Slug: meals, Provider: from (a)
//       - Launch URL: https://meals.mvissing.de
//    c. Applications → Outposts → k8s-forward-auth → add the Meals
//       application (the one outpost record the middleware already points at;
//       do not create a second outpost)
//    d. Bind a group to the Application as policy — without it every
//       authenticated estate user gets in (only you today, but the binding is
//       what makes that deliberate).
//
//    ⚠️ This gates the web client only. The API paths have no Authentik in
//    front of them, by design — see the header comment.
//
// 5. iOS: App Store → "Yet Another Meal Planner" → install → in the login
//    screen's server field enter https://meals.mvissing.de → log in.
//
// 6. Custom GPT (ChatGPT Plus): create a GPT, add an Action with
//    https://meals.mvissing.de/openapi.json as the schema, Authentication:
//    API Key / Bearer with the token from step 3. Paste the prompt-pack from
//    https://meals.mvissing.de/prompt-pack into the GPT's instructions — it
//    ships with the base URL filled in and teaches the metric-units
//    convention the API enforces.
//
// 7. DNS — nothing to add, same wildcard shape as trip.mvissing.de:
//    - Public zone: IONOS wildcard answers meals.mvissing.de with the ionos
//      address.
//    - Split-horizon: AdGuard's rewrite is *.mvissing.de → the site's own
//      ingress VIP, so this name is covered at both sites already.
//    - Verify after deploy: dig @192.168.1.2 / @192.168.178.3 meals.mvissing.de
//      → the site VIP; public resolver → 212.132.82.102.
//
// 8. Verify:
//    - curl https://meals.mvissing.de/healthz → 200 (unauthenticated)
//    - curl https://meals.mvissing.de/app/ → 302 to Authentik, on both edges
//    - curl https://meals.mvissing.de/ → JSON landing (the API's own gate)
//    - iOS login works; shopping list loads offline in airplane mode
//    - kubectl get pods -n meals → 1/1 Ready on brink-server
//
// Deliberately unset:
//   - SMTP — password reset returns a 503 and the app hides the option via
//     /client-config. The estate has no relay; changing a *known* password
//     needs nothing.
//   - METRICS_TOKEN — without it /metrics 404s and no metrics run. Wiring it
//     into Prometheus needs a scrape config with the bearer token (annotation
//     scraping cannot send one); add it as a ServiceMonitor if wanted later.
