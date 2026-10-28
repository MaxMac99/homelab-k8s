// Photonic — self-hosted photo management (github.com/MaxMac99/photonic):
// a Rust REST API (Axum, event-sourced on Postgres) consumed by a native iOS
// app. This is the **test deployment of `main`**, not a release channel.
//
// Image: every push to photonic's `main` that touches the server builds
// `:main` and `:sha-<commit>` (server.yml `publish`, linux/amd64 only, the
// commit is also in the `org.opencontainers.image.revision` label). The
// Deployment pins `:main` by digest (`PHOTONIC_DIGEST`), Renovate bumps it
// through its own custom manager, so each rollout is a visible, revertable
// commit — the meals.ts pattern. Release tags (`X.Y.Z`) are cut by hand in
// photonic's release workflow and are not tracked here. ⚠️ The package is
// **private**: the pod needs the GHCR pull secret (infrastructure/ghcr.ts) and
// Renovate the ghcr.io host rule in the Mend portal (see meals.ts step 0).
//
// Auth is the app's own: the iOS client does OAuth2 + PKCE against the
// "Photonic" Authentik application below and sends the access token as a
// bearer; the server validates it against Authentik's JWKS. ⚠️ So there is
// **no forward auth** on either Ingress — a native client cannot follow the
// outpost's 302, it would get a redirect instead of the API. The public edge
// is deliberately opened for this (the app must work off-LAN), and the JWT
// check is the only gate. Three provider settings are load-bearing for that
// check, each commented where it is set: `subMode`, the scope mappings and
// `signingKey`.
//
// Placement: **Winkel (maxdata)**, next to the NFS export that holds the
// photos and next to `postgres-winkel` with its database — NFS is reachable
// cross-site only at WAN latency (CLAUDE.md). amd64 only.
//
// ⚠️ One volume, mounted once at /data, for originals, cache *and* temp. The
// server moves uploads from temp into place with rename(2), which fails with
// EXDEV across mount points — two subPath mounts of the same export count as
// two. Do not split these into separate volumeMounts.

import * as k8s from "@pulumi/kubernetes";
import * as authentik from "@pulumi/authentik";
import * as pulumi from "@pulumi/pulumi";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import { ghcrPullSecret } from "../infrastructure/ghcr";
import {
  ARCH_LABEL,
  winkelSite,
  publicIngressClass,
} from "../infrastructure/sites";
import {
  defaultAuthorizationFlow,
  defaultInvalidationFlow,
  oauth2ScopeMappings,
  signingKey,
} from "../auth/authentik-config";
import { userMax } from "../auth/authentik-directory";
import {
  photonicDbPassword,
  postgresWinkelHost,
  postgresqlNamespace,
} from "../databases/postgresql";

// Digest of ghcr.io/maxmac99/photonic:main, bumped by Renovate's
// PHOTONIC_DIGEST manager. Kept out of the `image:` line on purpose: the
// generic image regex would read `main@sha256:…` as the version.
const PHOTONIC_DIGEST =
  "sha256:372099ac4a5613d18be0f8b5d095f17f0b840503795191fd086d9fab33f86cbc";

const photonicHost = "photonic.mvissing.de";
const oidcClientId = "photonic";
const oidcSlug = "photonic";

const namespace = new k8s.core.v1.Namespace("photonic", {
  metadata: {
    name: "photonic",
  },
});

const registryPullSecret = ghcrPullSecret(
  "photonic-registry-pull",
  namespace.metadata.name,
);

// The database lives on the Winkel cluster, owned by the `photonic` role
// declared in databases/postgresql.ts. The server runs its sqlx migrations on
// boot.
const photonicDatabase = new k8s.apiextensions.CustomResource(
  "photonic-database",
  {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Database",
    metadata: {
      name: "photonic-db",
      namespace: postgresqlNamespace,
    },
    spec: {
      name: "photonic",
      owner: "photonic",
      cluster: {
        name: "postgres-winkel",
      },
    },
  },
);

// Full connection string as one secret key, so the password stays out of the
// pod spec (same as meals.ts).
const photonicConfig = new k8s.core.v1.Secret("photonic-config", {
  metadata: {
    name: "photonic-config",
    namespace: namespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    DATABASE_URL: pulumi.interpolate`postgres://photonic:${photonicDbPassword}@${postgresWinkelHost}:5432/photonic`,
  },
});

// ---------------------------------------------------------------------------
// Storage — NFS on `tank`, statically bound.
//
// ⚠️ `storageClassName: "photonic-data"` names no real StorageClass, and that
// is correct — a matching key for the static bind, same as immich.ts. Do not
// "fix" this by adding an NFS provisioner.
//
// ⚠️ maxdata exports `/tank/k8s/nfs` as a whole (setup repo,
// hosts/nixos/maxdata/default.nix); the `photonic` subdirectory must exist
// before the first pod starts or the mount fails with ENOENT. See setup step 1.
// ---------------------------------------------------------------------------
const dataPV = new k8s.core.v1.PersistentVolume("photonic-data-pv", {
  metadata: { name: "photonic-data" },
  spec: {
    // Advisory only for a static NFS bind.
    capacity: { storage: "1Ti" },
    accessModes: ["ReadWriteMany"],
    persistentVolumeReclaimPolicy: "Retain",
    storageClassName: "photonic-data",
    mountOptions: ["nfsvers=4.2", "hard", "intr"],
    nfs: {
      server: "192.168.178.2", // maxdata
      path: "/tank/k8s/nfs/photonic",
    },
  },
});

const dataPVC = new k8s.core.v1.PersistentVolumeClaim("photonic-data-pvc", {
  metadata: { name: "photonic-data", namespace: namespace.metadata.name },
  spec: {
    accessModes: ["ReadWriteMany"],
    storageClassName: "photonic-data",
    volumeName: dataPV.metadata.name,
    resources: { requests: { storage: "1Ti" } },
  },
});

const photonicDeployment = new k8s.apps.v1.Deployment(
  "photonic",
  {
    metadata: {
      name: "photonic",
      namespace: namespace.metadata.name,
      labels: {
        app: "photonic",
      },
    },
    spec: {
      // Single instance: SERVER_MULTI_INSTANCE stays off, and Recreate keeps
      // two pods from ever running event handlers side by side mid-rollout.
      replicas: 1,
      strategy: {
        type: "Recreate",
      },
      selector: {
        matchLabels: {
          app: "photonic",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "photonic",
          },
        },
        spec: {
          nodeSelector: {
            [ARCH_LABEL]: "amd64",
            ...winkelSite,
          },
          imagePullSecrets: [
            {
              name: registryPullSecret.metadata.name,
            },
          ],
          containers: [
            {
              name: "photonic",
              // Digest-pinned `:main`, see PHOTONIC_DIGEST.
              image: `ghcr.io/maxmac99/photonic:main@${PHOTONIC_DIGEST}`,
              ports: [
                {
                  containerPort: 8080,
                  name: "http",
                  protocol: "TCP",
                },
              ],
              env: [
                {
                  name: "DATABASE_URL",
                  valueFrom: {
                    secretKeyRef: {
                      name: photonicConfig.metadata.name,
                      key: "DATABASE_URL",
                    },
                  },
                },
                // All three under the one /data mount — see the header.
                { name: "STORAGE_BASE_DIRECTORY", value: "/data/storage" },
                { name: "STORAGE_CACHE_DIRECTORY", value: "/data/cache/store" },
                { name: "STORAGE_TEMP_DIRECTORY", value: "/data/cache/tmp" },
                // OIDC: all four or none (the server refuses a partial set).
                // The client fetches the authorize/token URLs from
                // GET /api/v1/system, so they must be reachable from the
                // phone — the public URLs, as every app here dials Authentik.
                { name: "OAUTH_CLIENT_ID", value: oidcClientId },
                {
                  name: "OAUTH_AUTHORIZE_URL",
                  value: "https://auth.mvissing.de/application/o/authorize/",
                },
                {
                  name: "OAUTH_TOKEN_URL",
                  value: "https://auth.mvissing.de/application/o/token/",
                },
                {
                  name: "OAUTH_JWKS_URL",
                  value: `https://auth.mvissing.de/application/o/${oidcSlug}/jwks/`,
                },
                { name: "RUST_LOG", value: "info" },
              ],
              volumeMounts: [
                {
                  name: "data",
                  mountPath: "/data",
                },
              ],
              livenessProbe: {
                httpGet: {
                  // Unauthenticated (no auth layer on the system router).
                  path: "/api/v1/system",
                  port: 8080,
                },
                initialDelaySeconds: 15,
                periodSeconds: 30,
                timeoutSeconds: 5,
                failureThreshold: 5,
              },
              readinessProbe: {
                httpGet: {
                  path: "/api/v1/system",
                  port: 8080,
                },
                // Migrations run on boot; give them room.
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
                  cpu: "2",
                  memory: "1Gi",
                },
              },
            },
          ],
          volumes: [
            {
              name: "data",
              persistentVolumeClaim: {
                claimName: dataPVC.metadata.name,
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
      photonicDatabase,
      photonicConfig,
      registryPullSecret,
      dataPVC,
    ],
  },
);

const photonicService = new k8s.core.v1.Service("photonic-service", {
  metadata: {
    name: "photonic",
    namespace: namespace.metadata.name,
  },
  spec: {
    type: "ClusterIP",
    selector: {
      app: "photonic",
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

// One rule set for both edges, so they cannot drift. No forward auth and no
// outpost path — see the header comment.
const photonicRules = [
  {
    host: photonicHost,
    http: {
      paths: [
        {
          path: "/",
          pathType: "Prefix" as const,
          backend: {
            service: {
              name: photonicService.metadata.name,
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
// issuance (exactly one Ingress may carry the issuer annotation against the
// shared TLS Secret — see authentik.ts).
const photonicIngress = new k8s.networking.v1.Ingress("photonic-ingress", {
  metadata: {
    name: "photonic",
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
    rules: photonicRules,
    tls: [
      {
        secretName: "photonic-tls",
        hosts: [photonicHost],
      },
    ],
  },
});

// Public Ingress — the internet-facing Traefik on ionos. Without the issuer
// annotation and the HTTP→HTTPS redirect, for the reasons in meals.ts /
// trip.ts (one Certificate per Secret; the redirect would bounce every ACME
// challenge in the estate).
const photonicPublicIngress = new k8s.networking.v1.Ingress(
  "photonic-public-ingress",
  {
    metadata: {
      name: "photonic-public",
      namespace: namespace.metadata.name,
      annotations: {
        // Required on the public edge: traefik-public has no Service and never
        // writes an address into status.loadBalancer (see trip.ts).
        "pulumi.com/skipAwait": "true",
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      },
    },
    spec: {
      ingressClassName: publicIngressClass,
      rules: photonicRules,
      tls: [
        {
          secretName: "photonic-tls",
          hosts: [photonicHost],
        },
      ],
    },
  },
);

// ---------------------------------------------------------------------------
// Authentik — the OAuth2 provider the iOS app signs in against.
//
// A **public** client (PKCE, no secret): the app talks to Authentik directly
// with the URLs the server hands out in GET /api/v1/system.
const photonicOidcProvider = new authentik.ProviderOauth2(
  "photonic-oidc-provider",
  {
    name: "Photonic",
    clientId: oidcClientId,
    clientType: "public",
    // ⚠️ Must be set explicitly — an API-created provider gets an empty list
    // and rejects every login (apps/ha-mcp.ts).
    grantTypes: ["authorization_code"],
    authorizationFlow: defaultAuthorizationFlow.id,
    invalidationFlow: defaultInvalidationFlow.id,
    // ⚠️ `profile` is what puts `preferred_username` into the token, and the
    // server rejects any token without a username claim.
    propertyMappings: oauth2ScopeMappings,
    // ⚠️ Required: without it tokens are HS256 and the JWKS is empty.
    signingKey,
    // ⚠️ The server deserializes `sub` as a UUID. The default
    // (`hashed_user_id`) is a hex digest and fails every request with 401.
    subMode: "user_uuid",
    // The app does not refresh yet, so the access token is the session.
    accessTokenValidity: "hours=24",
    // ⚠️ Snake_case map keys — see apps/immich.ts.
    allowedRedirectUris: [
      {
        // PKCE.redirectURI in apple/Photonic/Features/Auth/Adapters.
        matching_mode: "strict",
        url: "photonic://oauth/callback",
        redirect_uri_type: "authorization",
      },
    ],
  },
);

const photonicApplication = new authentik.Application("photonic-application", {
  name: "Photonic",
  slug: oidcSlug,
  protocolProvider: photonicOidcProvider.providerOauth2Id.apply(Number),
  // Nothing to open in a browser: the iPhone app is the client.
  metaLaunchUrl: "blank://blank",
});

// Membership is managed: adding a tester is a code change.
const photonicUsersGroup = new authentik.Group("photonic-users-group", {
  name: "photonic-users",
  users: [userMax.id.apply(Number)],
});

new authentik.PolicyBinding("photonic-group-binding", {
  target: photonicApplication.uuid,
  group: photonicUsersGroup.id,
  order: 0,
});

export {
  namespace as photonicNamespace,
  photonicDeployment,
  photonicService,
  photonicIngress,
  photonicPublicIngress,
};

// Setup:
//
// 1. NFS directory, once, on maxdata:
//      sudo mkdir /tank/k8s/nfs/photonic
//    The export covers it already; the pod writes as root (no_root_squash).
//
// 2. Image: merge photonic's release-pipeline PR; the first main push builds
//    ghcr.io/maxmac99/photonic:main. Set PHOTONIC_DIGEST above to its digest
//      skopeo inspect --creds MaxMac99:<PAT> \
//        docker://ghcr.io/maxmac99/photonic:main | jq -r .Digest
//    — from then on Renovate bumps it. Pull credentials are the ones meals
//    already uses (infrastructure/ghcr.ts, Mend host rule), nothing new.
//
// 3. Deploy: pulumi up (via PR → merge → CI). Migrations run on boot.
//
// 4. DNS — nothing to add, same wildcard shape as meals.mvissing.de.
//
// 5. Verify:
//    - curl https://photonic.mvissing.de/api/v1/system → 200 with the OIDC
//      URLs, on both edges
//    - curl https://photonic.mvissing.de/api/v1/medium → 401 (gate works)
//    - TestFlight app → server https://photonic.mvissing.de → sign in →
//      library loads
//    - kubectl get pods -n photonic → 1/1 Ready on maxdata
