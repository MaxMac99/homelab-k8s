// Meals — "Yet Another Meal Planner", run from the private fork
// github.com/MaxMac99/meals (a copy of github.com/marco308/meals, not a GitHub
// fork: own changes on `main`, upstream merged in by a daily sync PR).
//
// A meal options planner: a recipe library with URL ingest, pools of meal
// options instead of a fixed Mon–Sun grid, and an aisle-sorted shopping list
// with full provenance. No built-in LLM — the AI access layer (REST API, the
// built-in MCP endpoint at /mcp, and the self-published /skill + /prompt-pack)
// is meant to be driven by an external assistant; the household uses a ChatGPT
// Custom GPT against /openapi.json with a personal API token.
//
// Single container (`ghcr.io/maxmac99/meals`): API, web client, skill and MCP
// endpoint are all served by the one image on port 8000. Pointed at Postgres
// via DATABASE_URL, it is **stateless** — no volume, no SQLite under /data.
//
// Image: every push to the fork's `main` builds `:main` and `:sha-<short>`
// (main-image.yml, linux/amd64 only). The Deployment pins `:main` by digest
// (`MEALS_DIGEST`), so each rollout is a visible, revertable commit; Renovate
// bumps the digest through its own custom manager. ⚠️ The package is
// **private**: the pod needs the GHCR pull secret (infrastructure/ghcr.ts),
// and Renovate needs a ghcr.io host rule in the Mend portal — without it the
// lookup fails with `no-result` and the digest never moves.
//
// ⚠️ Switching from upstream 1.11.0 to fork `main` migrates the schema
// **forward** on boot (Alembic, incl. `users.oidc_subject`). There is no way
// back to the upstream image without a manual downgrade — check the `meals`
// database backup (databases/backup.ts) before the first rollout.
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
//   - **Inside the app, "Sign in with Authentik"** (the fork's OIDC, web and
//     iPhone) replaces typing the Meals password: a second Authentik
//     application, "Meals Login", with a public OAuth2 provider. It still
//     ends in the app's own session token, so the split above is unchanged.
//     The first sign-in links the existing account by email address, so the
//     Meals account must use the same address as the Authentik user.
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
//
// The in-app chat (web and iPhone) is answered by the **agent sidecar**
// (`ghcr.io/maxmac99/meals-agent`, the fork's Dockerfile.agent; OPERATIONS.md
// "Agent sidecar"): the unmodified `claude` CLI on the household's Claude
// subscription, with Meals' own MCP endpoint as its only tools. The server
// still never calls a model; it hands each chat turn to the sidecar over the
// cluster network. The sidecar has no Ingress — only the meals pod reaches it.
// It exists only once `MEALS_AGENT_DIGEST` names a real image (see there).

import * as k8s from "@pulumi/kubernetes";
import * as authentik from "@pulumi/authentik";
import * as pulumi from "@pulumi/pulumi";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import { ghcrPullSecret } from "../infrastructure/ghcr";
import {
  ARCH_LABEL,
  BRINK_SERVER,
  brinkSite,
  onNode,
  publicIngressClass,
} from "../infrastructure/sites";
import { authentikOutpostService } from "../auth/authentik-outpost";
import {
  defaultAuthorizationFlow,
  defaultInvalidationFlow,
  mappingId,
  oauth2ScopeMappings,
  proxyScopeMappings,
  scopeMapping,
  signingKey,
} from "../auth/authentik-config";
import { forwardAuthOutpostRecord } from "../auth/authentik-forward-auth";
import {
  mealsDbPassword,
  postgresqlClusterName,
  postgresqlHost,
  postgresqlNamespace,
} from "../databases/postgresql";
import { haMcpUrl } from "./ha-mcp";

// Digest of ghcr.io/maxmac99/meals:main, bumped by Renovate's MEALS_DIGEST
// manager. Kept out of the `image:` line on purpose: the generic image regex
// would read `main@sha256:…` as the version.
const MEALS_DIGEST =
  "sha256:bac44ac1dfd63481c9bc374d9b695d31def4fbb626267e43ee3645538cff2d7c";

// Digest of ghcr.io/maxmac99/meals-agent:main, the chat's agent sidecar.
// Written by the fork's agent-image.yml rollout job (a sed over exactly this
// `const MEALS_AGENT_DIGEST =` … `;` block, the same as main-image.yml does for
// MEALS_DIGEST — keep the two-line shape) and by Renovate's
// MEALS_AGENT_DIGEST manager.
//
// ⚠️ The zeros are a placeholder, not a digest: no image exists until the
// meals PR #42 (the sidecar) is merged and agent-image.yml has run once. Its
// rollout replaces them with the real digest, and that commit is what turns
// the chat on — while the placeholder stands, `agentEnabled` is false and this
// file creates none of the agent's resources and sets no AGENT_* env, so it can
// be merged and deployed before the image exists.
const MEALS_AGENT_DIGEST =
  "sha256:3f9acb246382379efb961ad02679de65bf9d785a4b073bd5ac5c35fbaf94cc71";
const agentEnabled = !/^sha256:0{64}$/.test(MEALS_AGENT_DIGEST);

const config = new pulumi.Config();

// "Sign in with Authentik" (the app's own OIDC, not the forward auth on /app):
// the OAuth2 provider in the Authentik section below and the Deployment's
// OIDC_* env read the same two values. A public client's id is no secret.
const mealsHost = "meals.mvissing.de";
const oidcClientId = "meals";
const oidcSlug = "meals-login";
// The public URL, as every other app here dials Authentik; a token's `iss`
// must match it exactly. The server and the agent sidecar both read it — the
// sidecar finds the token endpoint through its discovery document.
const oidcIssuer = `https://auth.mvissing.de/application/o/${oidcSlug}/`;

// The agent sidecar's names. Fixed strings rather than resource outputs,
// because the meals Deployment names the sidecar's Service before it exists
// in this file.
const agentName = "meals-agent";
const agentPort = 8100;

const namespace = new k8s.core.v1.Namespace("meals", {
  metadata: {
    name: "meals",
  },
});

const registryPullSecret = ghcrPullSecret(
  "meals-registry-pull",
  namespace.metadata.name,
);

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

// The gate of both Authentik applications in the Authentik section below:
// only members of meals-users may open the web client or sign in.
// ⚠️ The group starts empty — after the first deploy, add yourself in
// Directory → Groups → meals-users, or /app answers 403 even after a
// successful login. The API/MCP paths stay outside Authentik entirely (see
// the header comment). Declared up here, not beside its policy bindings,
// because the agent's service account below is a member.
//
// ⚠️ Membership of people stays a UI action (no `users` here); the agent's
// account joins from its own side (`groups` on the User). Setting `users` on
// this group later would make Pulumi own the whole list and drop everyone
// added by hand.
const mealsUsersGroup = new authentik.Group("meals-users-group", {
  name: "meals-users",
});

// ---------------------------------------------------------------------------
// The agent sidecar's identity — only while MEALS_AGENT_DIGEST is real.
//
// The sidecar signs in to /mcp by itself with the OAuth2 `client_credentials`
// grant, so a chat turn never rides on a person's token: it acts as its own
// Meals account. It asks the **same** provider the people use ("Meals Login",
// below), so its token carries the issuer OIDC_ISSUER names and the audience
// OIDC_CLIENT_ID names, and the server needs no OIDC_AUDIENCES entry.
//
// Authentik's form of that grant: client_id is the provider's, client_secret
// is base64("<username>:<app password>"), which Authentik reads as a service
// account and one of its app-password tokens (docs.goauthentik.io, "Client
// credentials"). So no confidential provider and no second client id.
function mealsAgentIdentity() {
  // ⚠️ The email is not decoration: the first request with this account's
  // token creates its Meals account, and a Meals account needs an address.
  // It must be unique among Meals accounts; nothing is ever sent to it.
  const user = new authentik.User("meals-agent-user", {
    username: agentName,
    name: "Meals Agent",
    email: "meals-agent@mvissing.de",
    type: "service_account",
    // The client_credentials grant checks the application's policy bindings
    // against this user — outside meals-users Authentik refuses the token.
    groups: [mealsUsersGroup.id],
  });

  // The app password the client secret is made of. Non-expiring: an expired
  // one would stop the chat silently in a year, with nothing here to renew
  // it. `retrieveKey` puts the key into state (a secret output) — that is the
  // point, it is never typed anywhere.
  const token = new authentik.Token("meals-agent-token", {
    identifier: "meals-agent-client-credentials",
    description: "Meals agent sidecar: client_credentials for /mcp",
    user: user.id.apply(Number),
    intent: "app_password",
    expiring: false,
    retrieveKey: true,
  });

  const clientSecret = pulumi
    .secret(pulumi.interpolate`${user.username}:${token.key}`)
    .apply((pair) => Buffer.from(pair).toString("base64"));

  // Both of the agent's secrets in one object. The meals server reads only
  // AGENT_CLAUDE_TOKEN (it hands the subscription token to the sidecar with
  // each turn); the sidecar reads only AGENT_OIDC_CLIENT_SECRET.
  const secret = new k8s.core.v1.Secret(
    "meals-agent-secret",
    {
      metadata: {
        name: agentName,
        namespace: namespace.metadata.name,
      },
      type: "Opaque",
      stringData: {
        // `claude setup-token`'s output, valid for a year — renew it before
        // it runs out (pulumi config set --secret mealsAgentClaudeToken).
        AGENT_CLAUDE_TOKEN: config.requireSecret("mealsAgentClaudeToken"),
        AGENT_OIDC_CLIENT_SECRET: clientSecret,
      },
    },
    { dependsOn: [namespace] },
  );

  return { user, token, secret };
}

const agentIdentity = agentEnabled ? mealsAgentIdentity() : undefined;

// The meals server's half of the chat: where the sidecar is, who may chat and
// the subscription token. Empty while the agent is off — without AGENT_URL
// the server tells the clients the chat is off and its endpoints answer 404.
const agentServerEnv = agentIdentity
  ? [
      {
        name: "AGENT_URL",
        value: pulumi.interpolate`http://${agentName}.${namespace.metadata.name}.svc.cluster.local:${agentPort}`,
      },
      {
        // Who may chat: the provider subjects (`sub`), comma-separated. One
        // subscription backs every turn, so keep it to the household.
        //
        // ⚠️ No way to read a subject from the app (GET /auth/me does not
        // show it). After the person has signed in once, read it from the
        // database: `select subject, email from users;` in the `meals`
        // database (kubectl exec into the postgres primary, psql -d meals),
        // then `pulumi config set mealsAgentSubjects '<sub>,<sub>'`. Empty
        // means nobody sees the chat.
        name: "AGENT_SUBJECTS",
        value: config.get("mealsAgentSubjects") ?? "",
      },
      {
        name: "AGENT_CLAUDE_TOKEN",
        valueFrom: {
          secretKeyRef: {
            name: agentIdentity.secret.metadata.name,
            key: "AGENT_CLAUDE_TOKEN",
          },
        },
      },
    ]
  : [];

// ---------------------------------------------------------------------------
// Home Assistant (the fork's docs/plans/home-assistant.md, decision 10;
// OPERATIONS.md "Home Assistant"): Meals reaches Home Assistant only through
// ha-mcp (apps/ha-mcp.ts), never its REST or WebSocket API, and needs
// nothing in Home Assistant itself. A cook step's action ("preheat the oven")
// calls ha-mcp's ha_call_service, a waited signal ("core at 54 °C") is read
// with ha_get_state while a run waits, and each agent turn gets ha-mcp from
// the server to explore Home Assistant when it maps an appliance.
//
// ha-mcp admits only tokens it issued after a browser sign-in, so Meals is
// its OAuth client: someone connects it once in Meals' Settings (setup step
// 10), and the server keeps and refreshes that session in its database. The
// public URL, because the sign-in runs in the browser and Meals reads the
// OAuth endpoints from this server's metadata.
//
// ⚠️ ha-mcp acts as the Home Assistant **administrator** whose token it
// holds (haMcpHomeassistantToken), so Meals and its agent can switch
// anything there. The agent is told to use those tools only to explore; a
// step's action runs through Meals, during an open cooking run.
const homeAssistantServerEnv = [
  {
    name: "HA_MCP_URL",
    value: haMcpUrl,
  },
];

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
          imagePullSecrets: [
            {
              name: registryPullSecret.metadata.name,
            },
          ],
          containers: [
            {
              name: "meals",
              // Digest-pinned `:main` of the fork, see MEALS_DIGEST.
              image: `ghcr.io/maxmac99/meals:main@${MEALS_DIGEST}`,
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
                {
                  // See oidcIssuer.
                  name: "OIDC_ISSUER",
                  value: oidcIssuer,
                },
                {
                  name: "OIDC_CLIENT_ID",
                  value: oidcClientId,
                },
                {
                  // Authentik sends email_verified=false by default; every
                  // address in it is typed in by hand (auth/authentik-
                  // directory.ts), so linking the existing account by its
                  // address is safe. With registration closed, an address
                  // that matches no account gets a 403, not a new household.
                  name: "OIDC_TRUST_EMAIL",
                  value: "true",
                },
                ...agentServerEnv,
                ...homeAssistantServerEnv,
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
  {
    dependsOn: [
      namespace,
      mealsDatabase,
      mealsDbSecret,
      mealsConfig,
      registryPullSecret,
      ...(agentIdentity ? [agentIdentity.secret] : []),
    ],
  },
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

// ---------------------------------------------------------------------------
// The agent sidecar's workload — only while MEALS_AGENT_DIGEST is real.
function mealsAgentWorkload(identity: NonNullable<typeof agentIdentity>) {
  // The agent's transcripts (CLAUDE_CONFIG_DIR) and each turn's working
  // directory live here, so a chat resumes where it stopped after a restart
  // or a new image. Small: transcripts are text, and photos are never stored.
  //
  // ⚠️ local-path is node-local, so the pod below is pinned to the **node**
  // (brink-server), not just the site: the first binding decides for good
  // where this volume lives. Losing it only loses chat continuity — the
  // chats themselves are in the meals database.
  const pvc = new k8s.core.v1.PersistentVolumeClaim(
    "meals-agent-data",
    {
      metadata: {
        name: "meals-agent-data",
        namespace: namespace.metadata.name,
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "local-path",
        resources: {
          requests: {
            storage: "2Gi",
          },
        },
      },
    },
    { dependsOn: [namespace] },
  );

  const deployment = new k8s.apps.v1.Deployment(
    agentName,
    {
      metadata: {
        name: agentName,
        namespace: namespace.metadata.name,
        labels: {
          app: agentName,
        },
      },
      spec: {
        // The server runs one turn at a time anyway, and the RWO volume
        // cannot be shared: Recreate, never two pods on the transcripts.
        replicas: 1,
        strategy: {
          type: "Recreate",
        },
        selector: {
          matchLabels: {
            app: agentName,
          },
        },
        template: {
          metadata: {
            labels: {
              app: agentName,
            },
          },
          spec: {
            nodeSelector: {
              [ARCH_LABEL]: "amd64",
              ...onNode(BRINK_SERVER),
            },
            imagePullSecrets: [
              {
                name: registryPullSecret.metadata.name,
              },
            ],
            // Dockerfile.agent runs as uid/gid 1000 (`agent`).
            //
            // ⚠️ fsGroup does nothing on local-path — its volumes are
            // hostPath, which the kubelet never chowns (apps/t3code.ts hits
            // the same). The volume is writable anyway because the
            // provisioner creates every directory `mkdir -m 0777`
            // (infrastructure/local-path.ts); the sidecar and `claude`
            // create their subdirectories themselves. fsGroup stays for the
            // day this moves to a storage class that honours it.
            securityContext: {
              runAsUser: 1000,
              runAsGroup: 1000,
              runAsNonRoot: true,
              fsGroup: 1000,
            },
            volumes: [
              {
                name: "data",
                persistentVolumeClaim: {
                  claimName: pvc.metadata.name,
                },
              },
            ],
            containers: [
              {
                name: agentName,
                // Digest-pinned `:main` of the fork, see MEALS_AGENT_DIGEST.
                image: `ghcr.io/maxmac99/meals-agent:main@${MEALS_AGENT_DIGEST}`,
                ports: [
                  {
                    containerPort: agentPort,
                    name: "http",
                    protocol: "TCP",
                  },
                ],
                env: [
                  {
                    // The meals Service, in-cluster: the sidecar reads the
                    // skill from <MEALS_URL>/skill and the agent's tools
                    // from <MEALS_URL>/mcp. It sends no Origin header, so
                    // the MCP endpoint's browser-origin check lets it in.
                    name: "MEALS_URL",
                    value: pulumi.interpolate`http://${mealsService.metadata.name}.${namespace.metadata.name}.svc.cluster.local`,
                  },
                  {
                    // The same issuer the server checks tokens against.
                    // ⚠️ It is the public name, so the token request leaves
                    // the pod through the site's ingress VIP, exactly like
                    // the meals server's own JWKS fetch already does.
                    name: "OIDC_ISSUER",
                    value: oidcIssuer,
                  },
                  {
                    name: "AGENT_OIDC_CLIENT_ID",
                    value: oidcClientId,
                  },
                  {
                    name: "AGENT_OIDC_CLIENT_SECRET",
                    valueFrom: {
                      secretKeyRef: {
                        name: identity.secret.metadata.name,
                        key: "AGENT_OIDC_CLIENT_SECRET",
                      },
                    },
                  },
                  {
                    // `email` is what the server needs to make the agent's
                    // Meals account; `openid profile` as the people get.
                    name: "AGENT_OIDC_SCOPE",
                    value: "openid email profile",
                  },
                  {
                    name: "LOG_LEVEL",
                    value: "info",
                  },
                ],
                volumeMounts: [
                  {
                    // The image's VOLUME; its AGENT_WORK_DIR (…/work) and
                    // CLAUDE_CONFIG_DIR (…/claude) both point inside it.
                    name: "data",
                    mountPath: "/var/lib/meals-agent",
                  },
                ],
                livenessProbe: {
                  httpGet: {
                    // Answers 200 without touching the server or the model.
                    path: "/healthz",
                    port: agentPort,
                  },
                  initialDelaySeconds: 10,
                  periodSeconds: 30,
                  timeoutSeconds: 5,
                  failureThreshold: 5,
                },
                readinessProbe: {
                  httpGet: {
                    path: "/healthz",
                    port: agentPort,
                  },
                  initialDelaySeconds: 3,
                  periodSeconds: 10,
                  timeoutSeconds: 3,
                  failureThreshold: 6,
                },
                // `claude` is a Node-sized process per turn; one turn at a
                // time across the server, so 1Gi is the ceiling of one.
                resources: {
                  requests: {
                    cpu: "100m",
                    memory: "512Mi",
                  },
                  limits: {
                    cpu: "1",
                    memory: "1Gi",
                  },
                },
              },
            ],
          },
        },
      },
    },
    {
      dependsOn: [namespace, pvc, identity.secret, registryPullSecret],
    },
  );

  // ClusterIP only, no Ingress on either edge: the meals pod is the sidecar's
  // one caller (AGENT_URL).
  //
  // ⚠️ POST /turns has no auth of its own — the caller brings the Claude
  // token, and the sidecar adds its own Meals sign-in. So any pod in the
  // cluster that holds *some* Claude token could drive Meals' MCP as the
  // agent's account. Accepted like every other ClusterIP here (the estate
  // has no NetworkPolicies); a policy admitting only `app=meals` is the fix
  // if that ever matters.
  const service = new k8s.core.v1.Service(
    "meals-agent-service",
    {
      metadata: {
        name: agentName,
        namespace: namespace.metadata.name,
      },
      spec: {
        type: "ClusterIP",
        selector: {
          app: agentName,
        },
        ports: [
          {
            port: agentPort,
            targetPort: agentPort,
            name: "http",
            protocol: "TCP",
          },
        ],
      },
    },
    { dependsOn: [namespace] },
  );

  return { pvc, deployment, service };
}

const agentWorkload = agentIdentity
  ? mealsAgentWorkload(agentIdentity)
  : undefined;

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
//
// The chat (`/chats/…`, and its event stream `/chats/*/events/stream`, SSE)
// falls under `/`: no forward auth, the app's own bearer auth — iOS reads the
// stream too, and it cannot follow the outpost's redirect. Checked for the
// stream, nothing needed changing: neither edge has a buffering (or
// compress) middleware, on these Ingresses or on the entrypoints
// (infrastructure/traefik.ts, traefik-public.ts), and Traefik's proxy flushes
// a `text/event-stream` response as it is written. No writeTimeout is set,
// so Traefik v3's default of none applies and a long stream is not cut;
// `readTimeout` covers reading the request, which a GET has finished at once.
// ⚠️ Adding a Buffering or Compress middleware to `/` would turn the chat's
// events into bursts (OPERATIONS.md "Agent sidecar", step 5).
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

// `/app` exactly and everything under `/app/`, never a bare `/app` prefix:
// Traefik turns pathType Prefix into a string `PathPrefix`, so `/app` would
// also catch the API's `/appliances` and send iOS to the Authentik login
// (an HTML 200 the app cannot read).
const mealsAppBackend = {
  service: {
    name: mealsService.metadata.name,
    port: {
      number: 80,
    },
  },
};

const mealsAppRules = [
  {
    host: mealsHost,
    http: {
      paths: [
        {
          path: "/app",
          pathType: "Exact" as const,
          backend: mealsAppBackend,
        },
        {
          path: "/app/",
          pathType: "Prefix" as const,
          backend: mealsAppBackend,
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

// ---------------------------------------------------------------------------
// Authentik configuration-as-code — the proxy provider, application, outpost
// attachment and group policy that setup step 4 below used to do by hand.
//
// What this deliberately does *not* manage: the domain-level "Traefik" proxy
// provider and the pre-existing applications (Trip, Grafana, Paperless-ngx,
// Home Assistant, Immich). Those predate config-as-code and would need
// importing into state before code can take them over — the plan is to do
// that app-by-app as each one is next touched.
const mealsProxyProvider = new authentik.ProviderProxy("meals-proxy-provider", {
  name: "Meals",
  mode: "forward_single",
  externalHost: `https://${mealsHost}`,
  authorizationFlow: defaultAuthorizationFlow.id,
  invalidationFlow: defaultInvalidationFlow.id,
  propertyMappings: proxyScopeMappings,
  // The UI's default for a fresh provider, made explicit so the code object
  // matches what the UI would have made (and what Trip has).
  accessTokenValidity: "hours=24",
});

const mealsApplication = new authentik.Application("meals-application", {
  name: "Meals",
  slug: "meals",
  protocolProvider: mealsProxyProvider.providerProxyId.apply(Number),
  metaLaunchUrl: `https://${mealsHost}`,
});

// Attach to the single existing outpost — the UI equivalent of step 4(c).
// ⚠️ No outpost is created here. Creating one would fight authentik-outpost.ts,
// which deploys the pod this record serves.
new authentik.OutpostProviderAttachment("meals-outpost-attachment", {
  outpost: forwardAuthOutpostRecord.id,
  protocolProvider: mealsProxyProvider.providerProxyId.apply(Number),
});

// Step 4(d)'s gate: only members of meals-users may open the web client
// (mealsUsersGroup, declared above the meals Deployment because the agent's
// service account joins it).
new authentik.PolicyBinding("meals-group-binding", {
  target: mealsApplication.uuid,
  group: mealsUsersGroup.id,
  order: 0,
});

// "Sign in with Authentik" inside the app — a second application, because
// one Authentik application has one provider and "Meals" above is the
// forward-auth proxy. Both the web client and the iPhone app use it as a
// **public** client (PKCE, no secret): the web client through the server's
// /auth/oidc/authorize + /auth/oidc/code, the app directly.
const mealsOidcProvider = new authentik.ProviderOauth2("meals-oidc-provider", {
  name: "Meals Login",
  clientId: oidcClientId,
  clientType: "public",
  // ⚠️ Must be set explicitly — an API-created provider gets an empty list
  // and rejects every login (apps/ha-mcp.ts). `refresh_token` keeps both
  // clients signed in past the access token's lifetime.
  //
  // `client_credentials` only with the agent sidecar: it is how the sidecar
  // signs in to /mcp as its service account (mealsAgentIdentity).
  // ⚠️ Authentik's docs do not say whether a **public** provider accepts this
  // grant. Verify after the first deploy with the agent on (OPERATIONS.md
  // "Agent sidecar", step 2.5): `curl -s -d grant_type=client_credentials
  // -d client_id=meals -d client_secret=<AGENT_OIDC_CLIENT_SECRET from the
  // meals-agent Secret> -d 'scope=openid email profile'
  // https://auth.mvissing.de/application/o/token/` must return a token whose
  // `iss` is oidcIssuer, `aud` is `meals` and which has an `email`. If it is
  // refused, the sidecar needs a confidential provider of its own with the
  // same signing key, and its client id in the server's OIDC_AUDIENCES.
  grantTypes: [
    "authorization_code",
    "refresh_token",
    ...(agentEnabled ? ["client_credentials"] : []),
  ],
  authorizationFlow: defaultAuthorizationFlow.id,
  invalidationFlow: defaultInvalidationFlow.id,
  // ⚠️ offline_access is what makes Authentik issue a refresh token at all.
  // Without it Authentik drops the scope the clients ask for ("requested
  // scopes not configured, setting to overlap"), and the app signs out each
  // time the access token runs out.
  propertyMappings: [
    ...oauth2ScopeMappings,
    mappingId(scopeMapping.offlineAccess),
  ],
  // ⚠️ Required: without it the ID token is HS256, which meals refuses.
  signingKey,
  // ⚠️ Snake_case map keys — see apps/immich.ts.
  allowedRedirectUris: [
    {
      // The web client returns to /app/ itself.
      matching_mode: "strict",
      url: `https://${mealsHost}/app/`,
      redirect_uri_type: "authorization",
    },
    {
      // The iPhone app's callback (OIDCSignIn.swift in the fork).
      matching_mode: "strict",
      url: "de.mvissing.meals:/oidc/callback",
      redirect_uri_type: "authorization",
    },
  ],
});

const mealsOidcApplication = new authentik.Application(
  "meals-oidc-application",
  {
    name: "Meals Login",
    slug: oidcSlug,
    protocolProvider: mealsOidcProvider.providerOauth2Id.apply(Number),
    // Hidden from the library: the "Meals" tile above is the one to click.
    metaLaunchUrl: "blank://blank",
  },
);

// Same gate as the web client: meals-users only.
new authentik.PolicyBinding("meals-oidc-group-binding", {
  target: mealsOidcApplication.uuid,
  group: mealsUsersGroup.id,
  order: 0,
});

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

// `undefined` while MEALS_AGENT_DIGEST is the placeholder.
export const mealsAgentDeployment = agentWorkload?.deployment;
export const mealsAgentService = agentWorkload?.service;

// Setup:
//
// 0. Image (fork repo MaxMac99/meals): a push to `main` runs main-image.yml
//    and pushes ghcr.io/maxmac99/meals:main (private — verify once on
//    github.com/users/MaxMac99/packages). Set MEALS_DIGEST above to its
//    digest; from then on Renovate bumps it. Pull credentials:
//    - Cluster: the shared `tripRegistryPullToken` (infrastructure/ghcr.ts),
//      nothing new to set.
//    - Renovate: the `hostRules` entry in renovate.json, which reads the
//      Mend secret `tripRegistryPullToken` (developer.mend.io →
//      MaxMac99/homelab-k8s → Credentials → Secrets, the same classic PAT
//      with read:packages). A host rule set only in the portal never reached
//      the repo config. This also covers vacation-plan-view and
//      foreman-server.
//    ⚠️ Before the first rollout from upstream to the fork, check the meals
//    DB backup — the fork's migrations (users.oidc_subject …) run forward
//    and the upstream image cannot run against the result.
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
// 4. Authentik — now code, not clicks: the proxy provider, the application,
//    the outpost attachment and the meals-users group gate are created by
//    pulumi up (see the Authentik section in this file). Prerequisite: the
//    API provider must be bootstrapped once — `authentikToken` in stack
//    config, per the instructions at the top of auth/authentik-config.ts.
//    After the deploy, add yourself to the meals-users group (Directory →
//    Groups); until then /app answers 403 even after a successful login.
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
// 9. The chat (agent sidecar; OPERATIONS.md "Agent sidecar"):
//    a. Merge order: the meals PR #42 first; its agent-image.yml run builds
//       ghcr.io/maxmac99/meals-agent and commits the digest into
//       MEALS_AGENT_DIGEST here, which switches everything below on. This
//       file can merge before that — with the placeholder nothing happens.
//    b. The subscription token is stack config already
//       (`mealsAgentClaudeToken`, from `claude setup-token`, valid one year).
//    c. After the deploy, verify the client_credentials grant (the curl at
//       mealsOidcProvider's grantTypes). The service account `meals-agent`,
//       its app password and its meals-users membership are code.
//    d. Who may chat: read the subjects (`select subject, email from users;`
//       in the meals database), then
//       `pulumi config set mealsAgentSubjects '<sub>,<sub>'` and deploy.
//    e. Verify: kubectl get pods -n meals → meals-agent 1/1 Ready;
//       the chat button shows in the web client and answers.
//
// 10. Home Assistant (the fork's docs/plans/home-assistant.md; OPERATIONS.md
//     "Home Assistant"), through ha-mcp only — nothing to do in Home
//     Assistant itself:
//     a. Merge order: the meals PR #53 first. Until its images run here
//        HA_MCP_URL is read by nobody, so this file can merge before.
//     b. Deploy (ha-mcp then allows Meals' callback,
//        https://meals.mvissing.de/home/connection/callback). Then in Meals:
//        Settings → Home Assistant → "Connect Home Assistant", sign in at
//        Authentik as an admin (ha-mcp's binding), and the browser comes
//        back to Settings saying it is connected.
//     c. Verify:
//        - curl -s https://meals.mvissing.de/client-config | jq .home_assistant
//          → true
//        - kubectl logs -n meals deploy/meals | grep home\. → home.connected,
//          no home.states_unread.
//        - In the app: an appliance's chat → "Map in Home Assistant"; a
//          recipe adapted; a cooking run's "preheat" reaches the oven.
//        If Settings says "failed" with home-connect-refused, ha-mcp did not
//        take the callback: check OIDC_ALLOWED_CLIENT_REDIRECT_URIS in
//        apps/ha-mcp.ts against the address in the failure.
//
// Deliberately unset:
//   - SMTP — password reset returns a 503 and the app hides the option via
//     /client-config. The estate has no relay; changing a *known* password
//     needs nothing.
//   - METRICS_TOKEN — without it /metrics 404s and no metrics run. Wiring it
//     into Prometheus needs a scrape config with the bearer token (annotation
//     scraping cannot send one); add it as a ServiceMonitor if wanted later.
