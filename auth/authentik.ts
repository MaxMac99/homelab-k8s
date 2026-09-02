// Authentik - Identity Provider and SSO
// Uses shared PostgreSQL and Redis instances
// Provides authentication, authorization, and user management

import * as k8s from "@pulumi/kubernetes";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import {
  onNode,
  BRINK_SERVER,
  publicIngressClass,
} from "../infrastructure/sites";
import {
  blueprints,
  blueprintsChecksum,
  BLUEPRINTS_MOUNT_PATH,
} from "./authentik-blueprints";

// Import shared service connection info
import {
  postgresqlHost,
  postgresqlNamespace,
  postgresqlClusterName,
  authentikDbPassword,
} from "../databases/postgresql";

// Create namespace for Authentik
const namespace = new k8s.core.v1.Namespace("authentik", {
  metadata: {
    name: "authentik",
  },
});

// Generate secrets
const authentikSecretKey = new random.RandomPassword("authentik-secret-key", {
  length: 50,
  special: true,
});

// Store secrets in Kubernetes (in authentik namespace)
const authentikSecret = new k8s.core.v1.Secret("authentik-secret", {
  metadata: {
    name: "authentik-secret",
    namespace: namespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    AUTHENTIK_SECRET_KEY: authentikSecretKey.result,
  },
});

// Declaratively create Authentik database using CloudNativePG
// Uses the 'authentik' user created via declarative role management
const authentikDatabase = new k8s.apiextensions.CustomResource(
  "authentik-database",
  {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Database",
    metadata: {
      name: "authentik-db",
      namespace: postgresqlNamespace,
    },
    spec: {
      name: "authentik",
      owner: "authentik", // Use per-app user from declarative role management
      cluster: {
        name: postgresqlClusterName,
      },
    },
  },
);

// Create postgres-authentik secret directly in authentik namespace
// (Workaround for Reflector mirroring issues - creating it directly instead)
const postgresSecret = new k8s.core.v1.Secret("postgres-authentik-secret", {
  metadata: {
    name: "postgres-authentik",
    namespace: namespace.metadata.name,
  },
  type: "kubernetes.io/basic-auth",
  stringData: {
    username: "authentik",
    password: authentikDbPassword,
  },
});

// PVC for Authentik media files
const authentikMediaPVC = new k8s.core.v1.PersistentVolumeClaim(
  "authentik-media-pvc",
  {
    metadata: {
      name: "authentik-media",
      namespace: namespace.metadata.name,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: {
        requests: {
          storage: "5Gi",
        },
      },
    },
  },
);

// Dedicated Redis for Authentik, at Brink.
//
// Authentik used to share the Redis in databases/redis.ts, which is pinned to
// maxdata — so moving Authentik to brink-server without this would have left
// the exact dependency this move exists to remove. Postgres is replicated
// across both sites; Redis has no cross-site failover, so the answer is a
// second, small instance rather than replication.
//
// It stays dedicated rather than becoming a second shared instance: Paperless
// is the other Redis consumer and it lives at Winkel, so a shared broker would
// put the WAN overlay in the middle of one site's queue whichever node it sat
// on.
const authentikRedisPVC = new k8s.core.v1.PersistentVolumeClaim(
  "authentik-redis-pvc",
  {
    metadata: {
      name: "authentik-redis",
      namespace: namespace.metadata.name,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: {
        requests: {
          storage: "5Gi",
        },
      },
    },
  },
);

const authentikRedisDeployment = new k8s.apps.v1.Deployment(
  "authentik-redis",
  {
    metadata: {
      name: "authentik-redis",
      namespace: namespace.metadata.name,
    },
    spec: {
      replicas: 1,
      // Recreate, not RollingUpdate: the local-path volume is ReadWriteOnce,
      // so a second pod could never attach alongside the first anyway.
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: "authentik-redis" } },
      template: {
        metadata: { labels: { app: "authentik-redis" } },
        spec: {
          // Same node as the Authentik pods it serves.
          nodeSelector: onNode(BRINK_SERVER),
          containers: [
            {
              name: "redis",
              image: "redis:8.10.1-alpine",
              args: ["--appendonly", "yes", "--dir", "/data"],
              ports: [{ containerPort: 6379, name: "redis" }],
              volumeMounts: [{ name: "data", mountPath: "/data" }],
              resources: {
                requests: { cpu: "50m", memory: "64Mi" },
                limits: { cpu: "500m", memory: "512Mi" },
              },
              livenessProbe: {
                tcpSocket: { port: 6379 },
                initialDelaySeconds: 10,
                periodSeconds: 15,
              },
              readinessProbe: {
                exec: { command: ["redis-cli", "ping"] },
                initialDelaySeconds: 5,
                periodSeconds: 10,
              },
            },
          ],
          volumes: [
            {
              name: "data",
              persistentVolumeClaim: {
                claimName: authentikRedisPVC.metadata.name,
              },
            },
          ],
        },
      },
    },
  },
  { dependsOn: [authentikRedisPVC] },
);

const authentikRedisService = new k8s.core.v1.Service("authentik-redis", {
  metadata: {
    name: "authentik-redis",
    namespace: namespace.metadata.name,
  },
  spec: {
    selector: { app: "authentik-redis" },
    ports: [{ port: 6379, targetPort: 6379, name: "redis" }],
  },
});

const authentikRedisHost = pulumi.interpolate`${authentikRedisService.metadata.name}.${namespace.metadata.name}.svc.cluster.local`;

// Blueprints — declarative Authentik configuration, mounted into both pods.
//
// The content and the reasoning live in ./authentik-blueprints.ts; only the
// Kubernetes plumbing is here, because that file cannot see this namespace
// without a circular import.
//
// ⚠️ Mounted into the **worker as well as the server**, and the worker is the
// one that matters — blueprint discovery and application are worker tasks. The
// server gets it too so the admin interface can show the instance and its
// status rather than a file it cannot read.
const authentikBlueprints = new k8s.core.v1.ConfigMap("authentik-blueprints", {
  metadata: {
    name: "authentik-blueprints",
    namespace: namespace.metadata.name,
  },
  data: blueprints,
});

const blueprintsVolume = {
  name: "blueprints",
  configMap: { name: authentikBlueprints.metadata.name },
};

const blueprintsVolumeMount = {
  name: "blueprints",
  mountPath: BLUEPRINTS_MOUNT_PATH,
  readOnly: true,
};

/**
 * Pod annotation that rolls both Deployments when a blueprint changes.
 *
 * ⚠️ See the note on `blueprintsChecksum`. Without this, editing a blueprint
 * updates a ConfigMap that nothing rereads: the running pods keep the old file
 * mapped until the kubelet refreshes it, and Authentik only rescans at worker
 * start or on its hourly timer. The deploy would report success and the change
 * would appear not to have happened.
 */
const blueprintsAnnotation = {
  "blueprints.mvissing.de/checksum": blueprintsChecksum,
};

// Common environment variables for Authentik
const authentikEnv = [
  {
    name: "AUTHENTIK_SECRET_KEY",
    valueFrom: {
      secretKeyRef: {
        name: authentikSecret.metadata.name,
        key: "AUTHENTIK_SECRET_KEY",
      },
    },
  },
  {
    name: "AUTHENTIK_POSTGRESQL__HOST",
    value: postgresqlHost,
  },
  {
    name: "AUTHENTIK_POSTGRESQL__NAME",
    value: "authentik",
  },
  {
    name: "AUTHENTIK_POSTGRESQL__USER",
    value: "authentik", // Per-app user from declarative role management
  },
  {
    name: "AUTHENTIK_POSTGRESQL__PASSWORD",
    valueFrom: {
      secretKeyRef: {
        name: "postgres-authentik", // Mirrored by Reflector from database namespace
        key: "password",
      },
    },
  },
  {
    name: "AUTHENTIK_REDIS__HOST",
    value: authentikRedisHost,
  },
  {
    name: "AUTHENTIK_ERROR_REPORTING__ENABLED",
    value: "false",
  },
  {
    name: "AUTHENTIK_HOST",
    value: "https://auth.mvissing.de",
  },
  {
    name: "AUTHENTIK_OUTPOSTS__DISABLE_EMBEDDED_OUTPOST",
    value: "true", // Disable embedded outpost since we're using a separate microservice
  },
];

// Authentik Server Deployment
const authentikServer = new k8s.apps.v1.Deployment(
  "authentik-server",
  {
    metadata: {
      name: "authentik-server",
      namespace: namespace.metadata.name,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: "authentik-server",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "authentik-server",
          },
          annotations: {
            "prometheus.io/scrape": "true",
            "prometheus.io/port": "9300",
            "prometheus.io/path": "/metrics",
            ...blueprintsAnnotation,
          },
        },
        spec: {
          // Pinned to brink-server, not maxdata.
          //
          // Authentik is on the forward-auth path for every ingress at both
          // sites, so it must not depend on the site you are usually not at.
          // With it here and Postgres replicated across both sites, losing
          // maxdata no longer locks you out of Home Assistant running on this
          // same node.
          //
          // The media PVC below is local-path on this node and the worker
          // shares it, so both pods must agree — local-path is ReadWriteOnce
          // and a volume does not follow a pod to another node (D6).
          nodeSelector: onNode(BRINK_SERVER),
          containers: [
            {
              name: "authentik",
              image: "ghcr.io/goauthentik/server:2026.8.1",
              command: ["ak", "server"],
              env: authentikEnv,
              ports: [
                {
                  containerPort: 9000,
                  name: "http",
                },
                {
                  containerPort: 9443,
                  name: "https",
                },
                {
                  containerPort: 9300,
                  name: "metrics",
                },
              ],
              volumeMounts: [
                {
                  name: "media",
                  mountPath: "/media",
                },
                blueprintsVolumeMount,
              ],
              resources: {
                requests: {
                  memory: "256Mi",
                  cpu: "250m",
                },
                limits: {
                  memory: "1Gi",
                  cpu: "1000m",
                },
              },
            },
          ],
          volumes: [
            {
              name: "media",
              persistentVolumeClaim: {
                claimName: authentikMediaPVC.metadata.name,
              },
            },
            blueprintsVolume,
          ],
        },
      },
    },
  },
  { dependsOn: [authentikDatabase, authentikBlueprints] },
);

// Authentik Worker Deployment
const authentikWorker = new k8s.apps.v1.Deployment(
  "authentik-worker",
  {
    metadata: {
      name: "authentik-worker",
      namespace: namespace.metadata.name,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: "authentik-worker",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "authentik-worker",
          },
          annotations: blueprintsAnnotation,
        },
        spec: {
          // Same node as the server above — one local-path media volume.
          nodeSelector: onNode(BRINK_SERVER),
          containers: [
            {
              name: "authentik",
              image: "ghcr.io/goauthentik/server:2026.8.1",
              command: ["ak", "worker"],
              env: authentikEnv,
              volumeMounts: [
                {
                  name: "media",
                  mountPath: "/media",
                },
                blueprintsVolumeMount,
              ],
              resources: {
                requests: {
                  memory: "256Mi",
                  cpu: "250m",
                },
                limits: {
                  memory: "1Gi",
                  cpu: "1000m",
                },
              },
            },
          ],
          volumes: [
            {
              name: "media",
              persistentVolumeClaim: {
                claimName: authentikMediaPVC.metadata.name,
              },
            },
            blueprintsVolume,
          ],
        },
      },
    },
  },
  { dependsOn: [authentikDatabase, authentikBlueprints] },
);

// Authentik Service
const authentikService = new k8s.core.v1.Service("authentik-service", {
  metadata: {
    name: "authentik",
    namespace: namespace.metadata.name,
  },
  spec: {
    selector: {
      app: "authentik-server",
    },
    ports: [
      {
        port: 80,
        targetPort: 9000,
        name: "http",
      },
      {
        port: 443,
        targetPort: 9443,
        name: "https",
      },
    ],
  },
});

// The host rules, shared by the internal and public Ingresses below so that the
// two cannot drift apart — in particular the outpost path must keep winning
// over `/` in both of them.
const authentikIngressRules = [
  {
    host: "auth.mvissing.de",
    http: {
      paths: [
        // Route outpost paths to outpost service (must come first for priority)
        {
          path: "/outpost.goauthentik.io",
          pathType: "Prefix" as const,
          backend: {
            service: {
              name: "authentik-outpost", // Reference by name to avoid circular dependency
              port: {
                number: 9000,
              },
            },
          },
        },
        // Route all other paths to main Authentik server
        {
          path: "/",
          pathType: "Prefix" as const,
          backend: {
            service: {
              name: authentikService.metadata.name,
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

// Ingress for Authentik (using external Traefik on ionos edge node)
// Routes both main Authentik UI and outpost callback paths
const authentikIngress = new k8s.networking.v1.Ingress("authentik-ingress", {
  metadata: {
    name: "authentik",
    namespace: namespace.metadata.name,
    annotations: {
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "cert-manager.io/cluster-issuer": activeClusterIssuer,
      // Redirect HTTP to HTTPS
      "traefik.ingress.kubernetes.io/redirect-entry-point": "websecure",
      "traefik.ingress.kubernetes.io/redirect-permanent": "true",
      // Homepage dashboard discovery
      "gethomepage.dev/enabled": "true",
      "gethomepage.dev/name": "Authentik",
      "gethomepage.dev/description": "Identity Provider",
      "gethomepage.dev/group": "Infrastructure",
      "gethomepage.dev/icon": "authentik",
      "gethomepage.dev/pod-selector": "app=authentik-server",
      "gethomepage.dev/href": "https://auth.mvissing.de",
      // Authentik widget - shows user counts and login stats
      "gethomepage.dev/widget.type": "authentik",
      "gethomepage.dev/widget.url":
        "http://authentik.authentik.svc.cluster.local",
      "gethomepage.dev/widget.key": "{{HOMEPAGE_VAR_AUTHENTIK_TOKEN}}",
      "gethomepage.dev/widget.version": "2", // Authentik >= 2025.8.0
    },
  },
  spec: {
    ingressClassName: "traefik", // Changed from traefik-external - now using port forwarding on ionos
    rules: authentikIngressRules,
    tls: [
      {
        secretName: "authentik-tls",
        hosts: ["auth.mvissing.de"],
      },
    ],
  },
});

// Public Ingress for Authentik — the same routes, served by the internet-facing
// Traefik on ionos instead of the site-local one.
//
// A second Ingress rather than a class change on the one above: split-horizon
// DNS points *.mvissing.de at the site's own ingress VIP from inside either
// home, so LAN clients keep reaching Authentik over the LAN and only genuinely
// external clients traverse ionos. Both Ingresses name the same TLS Secret.
//
// ⚠️ Three things this deliberately does *not* copy from the Ingress above:
//
//   - `cert-manager.io/cluster-issuer`. That annotation drives ingress-shim,
//     which would create a *second* Certificate for auth.mvissing.de contending
//     with the first over the same `authentik-tls` Secret. The internal Ingress
//     owns issuance; this one only consumes the result.
//   - the `gethomepage.dev/*` annotations, which would put a duplicate tile on
//     the dashboard.
//   - the HTTP→HTTPS redirect, and that omission is load-bearing. The public
//     Traefik's `web` entrypoint on :80 is what serves cert-manager's HTTP-01
//     solver Ingresses for *every* certificate in the estate. Redirecting :80
//     to :443 here would bounce ACME challenges and stop renewal estate-wide
//     about 30 days later, long after the change that caused it. Plain-HTTP
//     callers get a 404 instead, which is the cheap half of that trade.
const authentikPublicIngress = new k8s.networking.v1.Ingress(
  "authentik-public-ingress",
  {
    metadata: {
      name: "authentik-public",
      namespace: namespace.metadata.name,
      annotations: {
        // ⚠️ Required here even though the internal Ingress does without it.
        // `traefik-public` runs with no Service and with `publishedService`
        // disabled (infrastructure/traefik-public.ts), so it never writes an
        // address into `status.loadBalancer` — and an address appearing there
        // is precisely what Pulumi waits for. Without this the deploy blocks
        // forever, on a resource that is only a declaration.
        "pulumi.com/skipAwait": "true",
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      },
    },
    spec: {
      ingressClassName: publicIngressClass,
      rules: authentikIngressRules,
      tls: [
        {
          secretName: "authentik-tls",
          hosts: ["auth.mvissing.de"],
        },
      ],
    },
  },
);

export {
  namespace as authentikNamespace,
  authentikBlueprints,
  authentikServer,
  authentikWorker,
  authentikService,
  authentikIngress,
  authentikPublicIngress,
};

// Setup instructions:
//
// 1. Ensure Reflector, cert-manager installed (✓ done in reflector.ts, cert-manager.ts)
//
// 2. Ensure DNS: auth.mvissing.de points to your ionos edge node's public IP
//
// 3. Deploy with: pulumi up
//    - 'authentik' role will be created via declarative role management
//    - Database will be created automatically by CloudNativePG Database CRD
//    - Reflector will mirror postgres-authentik secret to authentik namespace
//    - Certificate will be provisioned automatically by cert-manager
//
// 4. Check resources:
//    kubectl get database -n database authentik-db
//    kubectl get secret -n database postgres-authentik
//    kubectl get secret -n authentik postgres-authentik  # Mirrored by Reflector
//
// 5. Access Authentik at: https://auth.mvissing.de
//    Default credentials: akadmin / randomly generated
//    Get password: kubectl logs -n authentik deployment/authentik-server | grep "Bootstrap"
//
// How it works:
// - Pulumi generates a random password and creates postgres-authentik secret (in postgresql.ts)
// - CloudNativePG declarative role management creates 'authentik' PostgreSQL role with this password
// - CloudNativePG Database CRD declaratively creates 'authentik' database owned by 'authentik' role
// - Reflector automatically mirrors the postgres-authentik secret to authentik namespace
// - Authentik Server and Worker use the mirrored postgres-authentik secret
// - cert-manager provisions TLS certificate from Let's Encrypt
// - Traefik serves HTTPS traffic on the ionos edge node
