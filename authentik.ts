// Authentik - Identity Provider and SSO
// Uses shared PostgreSQL and Redis instances
// Provides authentication, authorization, and user management

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

// Import shared service connection info
import {
  postgresqlHost,
  postgresqlNamespace,
  postgresqlClusterName,
  authentikDbPassword
} from "./postgresql";
import { redisHost } from "./redis";

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
const authentikDatabase = new k8s.apiextensions.CustomResource("authentik-database", {
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
});

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
const authentikMediaPVC = new k8s.core.v1.PersistentVolumeClaim("authentik-media-pvc", {
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
});

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
    value: redisHost,
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
const authentikServer = new k8s.apps.v1.Deployment("authentik-server", {
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
        },
      },
      spec: {
        containers: [{
          name: "authentik",
          image: "ghcr.io/goauthentik/server:2025.10.2",
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
          volumeMounts: [{
            name: "media",
            mountPath: "/media",
          }],
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
        }],
        volumes: [{
          name: "media",
          persistentVolumeClaim: {
            claimName: authentikMediaPVC.metadata.name,
          },
        }],
      },
    },
  },
}, { dependsOn: [authentikDatabase] });

// Authentik Worker Deployment
const authentikWorker = new k8s.apps.v1.Deployment("authentik-worker", {
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
      },
      spec: {
        containers: [{
          name: "authentik",
          image: "ghcr.io/goauthentik/server:2025.10.2",
          command: ["ak", "worker"],
          env: authentikEnv,
          volumeMounts: [{
            name: "media",
            mountPath: "/media",
          }],
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
        }],
        volumes: [{
          name: "media",
          persistentVolumeClaim: {
            claimName: authentikMediaPVC.metadata.name,
          },
        }],
      },
    },
  },
}, { dependsOn: [authentikDatabase] });

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

// Ingress for Authentik (using external Traefik on ionos edge node)
// Routes both main Authentik UI and outpost callback paths
const authentikIngress = new k8s.networking.v1.Ingress("authentik-ingress", {
  metadata: {
    name: "authentik",
    namespace: namespace.metadata.name,
    annotations: {
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "cert-manager.io/cluster-issuer": "letsencrypt-prod",
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
      "gethomepage.dev/widget.url": "http://authentik.authentik.svc.cluster.local",
      "gethomepage.dev/widget.key": "{{HOMEPAGE_VAR_AUTHENTIK_TOKEN}}",
      "gethomepage.dev/widget.version": "2", // Authentik >= 2025.8.0
    },
  },
  spec: {
    ingressClassName: "traefik",  // Changed from traefik-external - now using port forwarding on ionos
    rules: [{
      host: "auth.mvissing.de",
      http: {
        paths: [
          // Route outpost paths to outpost service (must come first for priority)
          {
            path: "/outpost.goauthentik.io",
            pathType: "Prefix",
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
            pathType: "Prefix",
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
    }],
    tls: [{
      secretName: "authentik-tls",
      hosts: ["auth.mvissing.de"],
    }],
  },
});

export {
  namespace as authentikNamespace,
  authentikServer,
  authentikWorker,
  authentikService,
  authentikIngress,
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