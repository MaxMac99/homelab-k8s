// ha-mcp — the Home Assistant MCP server (github.com/homeassistant-ai/ha-mcp).
//
// Exposes Home Assistant to remote MCP clients — Claude.ai, ChatGPT, Claude
// Code/Desktop — at https://ha-mcp.mvissing.de/mcp. It runs as its own
// Deployment against Home Assistant's REST/WebSocket API rather than as the
// in-process custom component: that one rides Home Assistant's webhook URL,
// whose only credential is the secret in the path.
//
// ⚠️ Authentication is ha-mcp's **OIDC mode** (`ha-mcp-oidc`), with Authentik
// as the identity provider — not forward auth. MCP clients are OAuth clients:
// they discover `/.well-known/oauth-protected-resource`, register themselves
// dynamically (DCR) and send a bearer token. A forward-auth middleware would
// answer them with a 302 to an Authentik login page they cannot follow, same
// failure as the API paths in meals.ts. In OIDC mode ha-mcp (FastMCP's OIDC
// proxy) is the authorization server the clients see, and it delegates the
// actual login to the Authentik application below. Authentik's group binding
// is therefore the real gate: admins only, same as Home Assistant itself.
//
// ⚠️ OIDC is an **access gate, not per-user authorization**. Every
// authenticated session acts as the one Home Assistant user whose long-lived
// token is in `haMcpHomeassistantToken`. Anyone who passes the Authentik
// binding gets the full tool set of that user — automations, backups, restarts.
//
// ⚠️ Sessions refresh only for clients that request `offline_access`. ha-mcp
// itself requests only `openid` but passes on optional scopes a client asks
// for, and Authentik issues refresh tokens only for `offline_access` (mapped
// on the provider below). Every other client's session lives exactly as long
// as the Authentik access token (`accessTokenValidity` below) and then asks
// to reconnect. Revoking a user in Authentik does **not**
// end a live session: tokens are verified locally against Authentik's JWKS,
// not introspected. Shortening the validity is the only lever on both.
//
// Placement: Brink, next to Home Assistant. Every tool call is a request to
// Home Assistant, so this belongs on the same site; the local-path volume pins
// it to brink-server for good.

import * as k8s from "@pulumi/kubernetes";
import * as authentik from "@pulumi/authentik";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import {
  onNode,
  BRINK_SERVER,
  publicIngressClass,
} from "../infrastructure/sites";
import {
  defaultAuthorizationFlow,
  defaultInvalidationFlow,
  mappingId,
  oauth2ScopeMappings,
  scopeMapping,
  signingKey,
} from "../auth/authentik-config";
import { adminsGroup } from "../auth/authentik-directory";
import { homeassistantNamespace, homeassistantService } from "./homeassistant";

const config = new pulumi.Config();

// A long-lived access token created in Home Assistant's UI (profile →
// Security → Long-lived access tokens), for an **administrator** — several
// tools (backups, apps, system health) need admin. See setup step 1.
const homeassistantToken = config.requireSecret("haMcpHomeassistantToken");

const haMcpHost = "ha-mcp.mvissing.de";
const haMcpBaseUrl = `https://${haMcpHost}`;

// ---------------------------------------------------------------------------
// Authentik — a confidential OAuth2 provider for ha-mcp's OIDC proxy.
//
// The client id and secret are generated here rather than by Authentik, so
// they never need copying out of the UI: the provider and the Deployment read
// the same values.
const oauthClientId = new random.RandomString("ha-mcp-oauth-client-id", {
  length: 40,
  special: false,
});

const oauthClientSecret = new random.RandomPassword(
  "ha-mcp-oauth-client-secret",
  {
    length: 64,
    special: false,
  },
);

const haMcpOauth2Provider = new authentik.ProviderOauth2(
  "ha-mcp-oauth2-provider",
  {
    name: "Provider for ha-mcp",
    clientId: oauthClientId.result,
    clientSecret: oauthClientSecret.result,
    clientType: "confidential",
    // ⚠️ Must be set explicitly. A provider created through the API gets an
    // *empty* list — unlike the UI, which pre-selects them — and Authentik then
    // rejects every login with "invalid_request: The request is otherwise
    // malformed" (logged as "Invalid grant_type for provider").
    grantTypes: ["authorization_code", "refresh_token"],
    authorizationFlow: defaultAuthorizationFlow.id,
    invalidationFlow: defaultInvalidationFlow.id,
    // offline_access lets clients that ask for it (OpenCode, via its
    // `oauth.scope`) get a refresh token — see the header comment.
    propertyMappings: [
      ...oauth2ScopeMappings,
      mappingId(scopeMapping.offlineAccess),
    ],
    // ⚠️ Required, not cosmetic: without a signing key Authentik signs access
    // tokens HS256 with the client secret, and ha-mcp verifies them against
    // the JWKS from the discovery document — which would then be empty.
    signingKey,
    // The OIDC proxy's own callback. The MCP clients' redirect URIs never
    // reach Authentik — they are checked by ha-mcp against
    // OIDC_ALLOWED_CLIENT_REDIRECT_URIS below.
    // ⚠️ Snake_case map keys — see apps/immich.ts.
    allowedRedirectUris: [
      {
        matching_mode: "strict",
        url: `${haMcpBaseUrl}/auth/callback`,
        redirect_uri_type: "authorization",
      },
    ],
    // How long an MCP client stays connected before it has to sign in again —
    // see the header comment for why there is no refresh.
    accessTokenValidity: "days=7",
  },
);

const haMcpApplication = new authentik.Application("ha-mcp-application", {
  name: "Home Assistant MCP",
  slug: "ha-mcp",
  protocolProvider: haMcpOauth2Provider.providerOauth2Id.apply(Number),
  metaLaunchUrl: "blank://blank",
  metaDescription: "MCP server for Claude / ChatGPT",
});

// The authorization gate: admins only, same as the Home Assistant application.
new authentik.PolicyBinding("ha-mcp-group-binding", {
  target: haMcpApplication.uuid,
  group: adminsGroup.id,
  order: 0,
});

// ---------------------------------------------------------------------------
// Kubernetes

const namespace = new k8s.core.v1.Namespace("ha-mcp", {
  metadata: {
    name: "ha-mcp",
  },
});

const haMcpSecret = new k8s.core.v1.Secret("ha-mcp-secret", {
  metadata: {
    name: "ha-mcp",
    namespace: namespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    HOMEASSISTANT_TOKEN: homeassistantToken,
    OIDC_CLIENT_ID: oauthClientId.result,
    OIDC_CLIENT_SECRET: oauthClientSecret.result,
  },
});

// Persistent state: ha-mcp's settings (~/.ha-mcp) and the OIDC proxy's store
// of dynamically registered clients and upstream tokens (FASTMCP_HOME, moved
// onto the same volume below). ⚠️ Without it every restart forgets the
// registered clients, and Claude.ai / ChatGPT fail with an unknown-client
// error until the connector is removed and re-added.
const haMcpDataPVC = new k8s.core.v1.PersistentVolumeClaim("ha-mcp-data-pvc", {
  metadata: {
    name: "ha-mcp-data",
    namespace: namespace.metadata.name,
  },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "local-path",
    resources: {
      requests: {
        storage: "1Gi",
      },
    },
  },
});

const haMcpDeployment = new k8s.apps.v1.Deployment(
  "ha-mcp",
  {
    metadata: {
      name: "ha-mcp",
      namespace: namespace.metadata.name,
      labels: {
        app: "ha-mcp",
      },
    },
    spec: {
      replicas: 1,
      strategy: {
        // RWO local-path volume — the old pod must let go first.
        type: "Recreate",
      },
      selector: {
        matchLabels: {
          app: "ha-mcp",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "ha-mcp",
          },
        },
        spec: {
          // Node, not site: the local-path volume binds on first schedule.
          nodeSelector: onNode(BRINK_SERVER),
          securityContext: {
            // The image's mcpuser is pinned to 999:999; local-path hands out
            // root-owned directories, so the group has to be granted.
            fsGroup: 999,
          },
          containers: [
            {
              name: "ha-mcp",
              image: "ghcr.io/homeassistant-ai/ha-mcp:8.7.0",
              command: ["ha-mcp-oidc"],
              ports: [
                {
                  containerPort: 8086,
                  name: "http",
                  protocol: "TCP",
                },
              ],
              envFrom: [
                {
                  secretRef: {
                    name: haMcpSecret.metadata.name,
                  },
                },
              ],
              env: [
                {
                  // In-cluster, not https://home.mvissing.de: no hairpin
                  // through an ingress VIP, and no dependency on Traefik.
                  name: "HOMEASSISTANT_URL",
                  value: pulumi.interpolate`http://${homeassistantService.metadata.name}.${homeassistantNamespace.metadata.name}.svc.cluster.local`,
                },
                {
                  name: "OIDC_CONFIG_URL",
                  value: pulumi.interpolate`https://auth.mvissing.de/application/o/${haMcpApplication.slug}/.well-known/openid-configuration`,
                },
                {
                  name: "MCP_BASE_URL",
                  value: haMcpBaseUrl,
                },
                {
                  // ⚠️ Without this list any dynamically registered client may
                  // name its own redirect URI, so anyone could register a
                  // client that ships an admin's authorization code to
                  // themselves. Exactly the clients in use, nothing broader.
                  // Loopback patterns without a port match any port (RFC
                  // 8252), which is what Claude Code and Claude Desktop use.
                  name: "OIDC_ALLOWED_CLIENT_REDIRECT_URIS",
                  value: [
                    "https://claude.ai/api/mcp/auth_callback",
                    "https://claude.com/api/mcp/auth_callback",
                    // ChatGPT uses the stable URI when the authorization
                    // server advertises RFC 9207 `iss` (FastMCP's proxy does),
                    // the per-callback one otherwise.
                    "https://chatgpt.com/connector_platform_oauth_redirect",
                    "https://chatgpt.com/connector/oauth/*",
                    // Older ChatGPT connectors and Custom GPT actions.
                    "https://chatgpt.com/aip/*/oauth/callback",
                    "http://localhost/callback",
                    "http://127.0.0.1/callback",
                  ].join(","),
                },
                {
                  // The settings UI is served on a secret path that bypasses
                  // OIDC entirely. On an internet-facing host the only
                  // credential would be that path, so it is not served at all;
                  // tool and feature settings go through env vars instead.
                  name: "HA_MCP_DISABLE_SETTINGS_UI",
                  value: "true",
                },
                {
                  // Unauthenticated GET /healthz, for the probes below.
                  name: "MCP_HEALTHZ",
                  value: "true",
                },
                {
                  // Upstream default is ~/.local/share/fastmcp, which is not on
                  // the volume. See the PVC comment.
                  name: "FASTMCP_HOME",
                  value: "/home/mcpuser/.ha-mcp/fastmcp",
                },
              ],
              volumeMounts: [
                {
                  name: "data",
                  mountPath: "/home/mcpuser/.ha-mcp",
                },
              ],
              livenessProbe: {
                httpGet: {
                  path: "/healthz",
                  port: 8086,
                },
                initialDelaySeconds: 20,
                periodSeconds: 30,
                timeoutSeconds: 5,
              },
              readinessProbe: {
                httpGet: {
                  path: "/healthz",
                  port: 8086,
                },
                initialDelaySeconds: 5,
                periodSeconds: 10,
                timeoutSeconds: 3,
                failureThreshold: 6,
              },
              resources: {
                requests: {
                  cpu: "50m",
                  memory: "256Mi",
                },
                limits: {
                  cpu: "1000m",
                  memory: "1Gi",
                },
              },
            },
          ],
          volumes: [
            {
              name: "data",
              persistentVolumeClaim: {
                claimName: haMcpDataPVC.metadata.name,
              },
            },
          ],
        },
      },
    },
  },
  { dependsOn: [haMcpSecret, haMcpDataPVC] },
);

const haMcpService = new k8s.core.v1.Service("ha-mcp-service", {
  metadata: {
    name: "ha-mcp",
    namespace: namespace.metadata.name,
  },
  spec: {
    type: "ClusterIP",
    selector: {
      app: "ha-mcp",
    },
    ports: [
      {
        port: 80,
        targetPort: 8086,
        name: "http",
        protocol: "TCP",
      },
    ],
  },
});

// One rule set for both edges. The whole host goes to ha-mcp: besides /mcp it
// serves the OAuth endpoints (/.well-known/*, /register, /authorize, /token,
// /auth/callback), and every one of them must be reachable from the
// internet — Claude.ai and ChatGPT connect from their own clouds.
const haMcpIngressRules = [
  {
    host: haMcpHost,
    http: {
      paths: [
        {
          path: "/",
          pathType: "Prefix" as const,
          backend: {
            service: {
              name: haMcpService.metadata.name,
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

// Internal Ingress — site-local Traefik, for clients inside the homes
// (split-horizon DNS). Owns certificate issuance for the shared TLS Secret.
const haMcpIngress = new k8s.networking.v1.Ingress("ha-mcp-ingress", {
  metadata: {
    name: "ha-mcp",
    namespace: namespace.metadata.name,
    annotations: {
      "pulumi.com/skipAwait": "true",
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "cert-manager.io/cluster-issuer": activeClusterIssuer,

      "traefik.ingress.kubernetes.io/redirect-entry-point": "websecure",
      "traefik.ingress.kubernetes.io/redirect-permanent": "true",
    },
  },
  spec: {
    ingressClassName: "traefik",
    rules: haMcpIngressRules,
    tls: [
      {
        secretName: "ha-mcp-tls",
        hosts: [haMcpHost],
      },
    ],
  },
});

// Public Ingress — traefik-public on ionos. No issuer, no redirect: see the
// equivalent comment in meals.ts.
const haMcpPublicIngress = new k8s.networking.v1.Ingress(
  "ha-mcp-public-ingress",
  {
    metadata: {
      name: "ha-mcp-public",
      namespace: namespace.metadata.name,
      annotations: {
        // traefik-public never writes status.loadBalancer — see trip.ts.
        "pulumi.com/skipAwait": "true",
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      },
    },
    spec: {
      ingressClassName: publicIngressClass,
      rules: haMcpIngressRules,
      tls: [
        {
          secretName: "ha-mcp-tls",
          hosts: [haMcpHost],
        },
      ],
    },
  },
);

export {
  namespace as haMcpNamespace,
  haMcpDeployment,
  haMcpService,
  haMcpIngress,
  haMcpPublicIngress,
};

// Setup:
//
// 1. Home Assistant: as an administrator, profile → Security → Long-lived
//    access tokens → Create token ("ha-mcp"). Then, before deploying:
//      pulumi config set --secret haMcpHomeassistantToken <token>
//    `requireSecret` fails the whole deploy while this is missing.
//
// 2. Deploy: pulumi up. Authentik provider, application and the admins
//    binding are created by it — nothing to click.
//
// 3. Verify:
//    - curl https://ha-mcp.mvissing.de/healthz → 200
//    - curl -i https://ha-mcp.mvissing.de/mcp → 401 with a WWW-Authenticate
//      header pointing at /.well-known/oauth-protected-resource
//    - kubectl logs -n ha-mcp deploy/ha-mcp → "Starting OIDC-enabled MCP
//      server" and no HA connection errors
//
// 4. Clients — the endpoint is https://ha-mcp.mvissing.de/mcp everywhere:
//    - Claude.ai: Customize → Connectors → Add custom connector → URL → Add →
//      Connect → Authentik login.
//    - ChatGPT (web only): https://chatgpt.com/plugins → + → Add custom MCP
//      server → URL, authentication OAuth → Create as a plugin → Authentik
//      login. ⚠️ Write tools need a Business/Enterprise/Edu workspace; Pro
//      gets read/fetch only.
//    - Claude Code: claude mcp add --transport http home-assistant
//      https://ha-mcp.mvissing.de/mcp, then /mcp → Authenticate.
//    A client whose redirect URI is not in OIDC_ALLOWED_CLIENT_REDIRECT_URIS
//    fails at registration — add its exact callback there.
//
// 5. DNS: nothing to add. The public wildcard and both split-horizon rewrites
//    already cover *.mvissing.de (see meals.ts step 7).
