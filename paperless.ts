// Paperless-ngx - Document Management System
// Uses shared PostgreSQL and Redis instances
// Includes Gotenberg (Office conversion) and Tika (text extraction)
// Media storage on NFS (tank pool), data/consume on fast local storage

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

// Import shared service connection info
import {
  postgresqlHost,
  postgresqlNamespace,
  postgresqlClusterName,
} from "./postgresql";
import { redisHost } from "./redis";

// Create namespace for Paperless
const namespace = new k8s.core.v1.Namespace("paperless", {
  metadata: {
    name: "paperless",
  },
});

// Note: PostgreSQL password secret is created in postgresql.ts
// and mirrored to this namespace via Reflector

// Get Pulumi config for sensitive values
const config = new pulumi.Config();
const paperlessSecretKey = config.requireSecret("paperless-secret-key");
const authentikClientId = config.requireSecret("paperless-authentik-client-id");
const authentikClientSecret = config.requireSecret("paperless-authentik-client-secret");
const metricsApiToken = config.requireSecret("paperless-metrics-api-token");

// Store secrets in Kubernetes (in paperless namespace)
const paperlessSecret = new k8s.core.v1.Secret("paperless-secret", {
  metadata: {
    name: "paperless-secret",
    namespace: namespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    PAPERLESS_SECRET_KEY: paperlessSecretKey,
    // Authentik OAuth2/OIDC credentials
    PAPERLESS_APPS: "allauth.socialaccount.providers.openid_connect",
    PAPERLESS_SOCIALACCOUNT_PROVIDERS: pulumi.all([authentikClientId, authentikClientSecret]).apply(([clientId, clientSecret]) =>
      JSON.stringify({
        openid_connect: {
          SERVERS: [{
            id: "authentik",
            name: "Authentik",
            server_url: "https://auth.mvissing.de/application/o/paperless/.well-known/openid-configuration",
            token_auth_method: "client_secret_basic",
            APP: {
              client_id: clientId,
              secret: clientSecret,
            },
          }],
        },
      })
    ),
  },
});

// Metrics API token secret
const metricsTokenSecret = new k8s.core.v1.Secret("paperless-metrics-token", {
  metadata: {
    name: "paperless-metrics-token",
    namespace: namespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    token: metricsApiToken,
  },
});

// Declaratively create Paperless database using CloudNativePG
const paperlessDatabase = new k8s.apiextensions.CustomResource("paperless-database", {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Database",
  metadata: {
    name: "paperless-db",
    namespace: postgresqlNamespace,
  },
  spec: {
    name: "paperless",
    owner: "paperless",
    cluster: {
      name: postgresqlClusterName,
    },
  },
});

// Update PostgreSQL cluster to add paperless role
// Note: This should be added to postgresql.ts managed.roles array
// For now, we'll document this as a manual step

// NFS Persistent Volume for media storage (on tank pool)
const paperlessMediaPV = new k8s.core.v1.PersistentVolume("paperless-media-pv", {
  metadata: {
    name: "paperless-media",
  },
  spec: {
    capacity: {
      storage: "300Gi", // Large capacity for document archive
    },
    accessModes: ["ReadWriteMany"],
    persistentVolumeReclaimPolicy: "Retain",
    storageClassName: "nfs",
    mountOptions: [
      "nfsvers=4.2",
      "hard",
      "intr",
    ],
    nfs: {
      server: "192.168.178.2", // maxdata NFS server
      path: "/tank/k8s/nfs/paperless-media",
    },
  },
});

// PVC for NFS media storage
const paperlessMediaPVC = new k8s.core.v1.PersistentVolumeClaim("paperless-media-pvc", {
  metadata: {
    name: "paperless-media",
    namespace: namespace.metadata.name,
  },
  spec: {
    accessModes: ["ReadWriteMany"],
    storageClassName: "nfs",
    volumeName: paperlessMediaPV.metadata.name,
    resources: {
      requests: {
        storage: "300Gi",
      },
    },
  },
});

// PVC for data storage (search index, ML models, cache)
const paperlessDataPVC = new k8s.core.v1.PersistentVolumeClaim("paperless-data-pvc", {
  metadata: {
    name: "paperless-data",
    namespace: namespace.metadata.name,
  },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "local-path",
    resources: {
      requests: {
        storage: "20Gi",
      },
    },
  },
});

// PVC for consume directory (incoming documents)
const paperlessConsumePVC = new k8s.core.v1.PersistentVolumeClaim("paperless-consume-pvc", {
  metadata: {
    name: "paperless-consume",
    namespace: namespace.metadata.name,
  },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "local-path",
    resources: {
      requests: {
        storage: "10Gi",
      },
    },
  },
});

// Gotenberg Deployment (Office document conversion)
const gotenbergDeployment = new k8s.apps.v1.Deployment("gotenberg", {
  metadata: {
    name: "gotenberg",
    namespace: namespace.metadata.name,
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        app: "gotenberg",
      },
    },
    template: {
      metadata: {
        labels: {
          app: "gotenberg",
        },
      },
      spec: {
        containers: [{
          name: "gotenberg",
          image: "gotenberg/gotenberg:8.25.0",
          ports: [{
            containerPort: 3000,
            name: "http",
          }],
          command: [
            "gotenberg",
            "--chromium-disable-javascript=true",
            "--chromium-allow-list=file:///tmp/.*",
          ],
          resources: {
            requests: {
              memory: "256Mi",
              cpu: "100m",
            },
            limits: {
              memory: "1Gi",
              cpu: "1000m",
            },
          },
        }],
      },
    },
  },
});

// Gotenberg Service
const gotenbergService = new k8s.core.v1.Service("gotenberg-service", {
  metadata: {
    name: "gotenberg",
    namespace: namespace.metadata.name,
  },
  spec: {
    selector: {
      app: "gotenberg",
    },
    ports: [{
      port: 3000,
      targetPort: 3000,
      name: "http",
    }],
  },
});

// Tika Deployment (Document text extraction)
const tikaDeployment = new k8s.apps.v1.Deployment("tika", {
  metadata: {
    name: "tika",
    namespace: namespace.metadata.name,
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        app: "tika",
      },
    },
    template: {
      metadata: {
        labels: {
          app: "tika",
        },
      },
      spec: {
        containers: [{
          name: "tika",
          image: "apache/tika:3.2.3.0",
          ports: [{
            containerPort: 9998,
            name: "http",
          }],
          resources: {
            requests: {
              memory: "512Mi",
              cpu: "100m",
            },
            limits: {
              memory: "2Gi",
              cpu: "1000m",
            },
          },
        }],
      },
    },
  },
});

// Tika Service
const tikaService = new k8s.core.v1.Service("tika-service", {
  metadata: {
    name: "tika",
    namespace: namespace.metadata.name,
  },
  spec: {
    selector: {
      app: "tika",
    },
    ports: [{
      port: 9998,
      targetPort: 9998,
      name: "http",
    }],
  },
});

// Paperless-ngx Deployment
const paperlessDeployment = new k8s.apps.v1.Deployment("paperless", {
  metadata: {
    name: "paperless",
    namespace: namespace.metadata.name,
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        app: "paperless",
      },
    },
    template: {
      metadata: {
        labels: {
          app: "paperless",
        },
        annotations: {
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9999",  // Metrics exporter sidecar
          "prometheus.io/path": "/metrics",
        },
      },
      spec: {
        containers: [{
          name: "paperless",
          image: "ghcr.io/paperless-ngx/paperless-ngx:2.20",
          ports: [{
            containerPort: 8000,
            name: "http",
          }],
          env: [
            // Database configuration
            {
              name: "PAPERLESS_DBHOST",
              value: postgresqlHost,
            },
            {
              name: "PAPERLESS_DBNAME",
              value: "paperless",
            },
            {
              name: "PAPERLESS_DBUSER",
              value: "paperless",
            },
            {
              name: "PAPERLESS_DBPASS",
              valueFrom: {
                secretKeyRef: {
                  name: "postgres-paperless",
                  key: "password",
                },
              },
            },
            {
              name: "PAPERLESS_DBPORT",
              value: "5432",
            },
            // Redis configuration
            {
              name: "PAPERLESS_REDIS",
              value: pulumi.interpolate`redis://${redisHost}:6379`,
            },
            // Secret key
            {
              name: "PAPERLESS_SECRET_KEY",
              valueFrom: {
                secretKeyRef: {
                  name: paperlessSecret.metadata.name,
                  key: "PAPERLESS_SECRET_KEY",
                },
              },
            },
            // URL and CORS
            {
              name: "PAPERLESS_URL",
              value: "https://dms.mvissing.de",
            },
            {
              name: "PAPERLESS_CSRF_TRUSTED_ORIGINS",
              value: "https://dms.mvissing.de",
            },
            {
              name: "PAPERLESS_ALLOWED_HOSTS",
              value: "dms.mvissing.de,paperless.paperless.svc.cluster.local",
            },
            {
              name: "PAPERLESS_CORS_ALLOWED_HOSTS",
              value: "https://dms.mvissing.de",
            },
            // Gotenberg and Tika
            {
              name: "PAPERLESS_TIKA_ENABLED",
              value: "1",
            },
            {
              name: "PAPERLESS_TIKA_ENDPOINT",
              value: "http://tika:9998",
            },
            {
              name: "PAPERLESS_TIKA_GOTENBERG_ENDPOINT",
              value: "http://gotenberg:3000",
            },
            // OCR settings
            {
              name: "PAPERLESS_OCR_LANGUAGE",
              value: "deu", // German + English
            },
            {
              name: "PAPERLESS_OCR_LANGUAGES",
              value: "deu eng", // German + English
            },
            // Time zone
            {
              name: "PAPERLESS_TIME_ZONE",
              value: "Europe/Berlin",
            },
            // Override Kubernetes-injected PAPERLESS_PORT (otherwise Granian fails)
            {
              name: "PAPERLESS_PORT",
              value: "8000",
            },
            // Authentik SSO configuration
            {
              name: "PAPERLESS_APPS",
              valueFrom: {
                secretKeyRef: {
                  name: paperlessSecret.metadata.name,
                  key: "PAPERLESS_APPS",
                },
              },
            },
            {
              name: "PAPERLESS_SOCIALACCOUNT_PROVIDERS",
              valueFrom: {
                secretKeyRef: {
                  name: paperlessSecret.metadata.name,
                  key: "PAPERLESS_SOCIALACCOUNT_PROVIDERS",
                },
              },
            },
            // Enable auto-login via SSO (optional)
            {
              name: "PAPERLESS_SOCIAL_AUTO_SIGNUP",
              value: "True",
            },
            {
              name: "PAPERLESS_REDIRECT_LOGIN_TO_SSO",
              value: "True",
            },
            {
              name: "PAPERLESS_DISABLE_REGULAR_LOGIN",
              value: "True",
            },
          ],
          volumeMounts: [
            {
              name: "data",
              mountPath: "/usr/src/paperless/data",
            },
            {
              name: "media",
              mountPath: "/usr/src/paperless/media",
            },
            {
              name: "consume",
              mountPath: "/usr/src/paperless/consume",
            },
          ],
          resources: {
            requests: {
              memory: "1Gi",
              cpu: "500m",
            },
            limits: {
              memory: "4Gi",
              cpu: "2000m",
            },
          },
        },
        // Prometheus exporter sidecar
        {
          name: "metrics-exporter",
          image: "ghcr.io/hansmi/prometheus-paperless-exporter:v0.0.8",
          args: [
            "--web.listen-address=:9999",
          ],
          env: [
            {
              name: "PAPERLESS_URL",
              value: "http://localhost:8000",
            },
            {
              name: "PAPERLESS_AUTH_TOKEN",
              valueFrom: {
                secretKeyRef: {
                  name: metricsTokenSecret.metadata.name,
                  key: "token",
                },
              },
            },
          ],
          ports: [{
            containerPort: 9999,
            name: "metrics",
          }],
          resources: {
            requests: {
              memory: "32Mi",
              cpu: "50m",
            },
            limits: {
              memory: "128Mi",
              cpu: "200m",
            },
          },
        }],
        volumes: [
          {
            name: "data",
            persistentVolumeClaim: {
              claimName: paperlessDataPVC.metadata.name,
            },
          },
          {
            name: "media",
            persistentVolumeClaim: {
              claimName: paperlessMediaPVC.metadata.name,
            },
          },
          {
            name: "consume",
            persistentVolumeClaim: {
              claimName: paperlessConsumePVC.metadata.name,
            },
          },
        ],
      },
    },
  },
}, { dependsOn: [paperlessDatabase, gotenbergDeployment, tikaDeployment] });

// Paperless Service
const paperlessService = new k8s.core.v1.Service("paperless-service", {
  metadata: {
    name: "paperless",
    namespace: namespace.metadata.name,
  },
  spec: {
    selector: {
      app: "paperless",
    },
    ports: [{
      port: 80,
      targetPort: 8000,
      name: "http",
    }],
  },
});

// Ingress for Paperless (both internal and external access)
const paperlessIngress = new k8s.networking.v1.Ingress("paperless-ingress", {
  metadata: {
    name: "paperless",
    namespace: namespace.metadata.name,
    annotations: {
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "cert-manager.io/cluster-issuer": "letsencrypt-prod",
      // Redirect HTTP to HTTPS
      "traefik.ingress.kubernetes.io/redirect-entry-point": "websecure",
      "traefik.ingress.kubernetes.io/redirect-permanent": "true",
      // Homepage dashboard discovery
      "gethomepage.dev/enabled": "true",
      "gethomepage.dev/name": "Paperless",
      "gethomepage.dev/description": "Document Management",
      "gethomepage.dev/group": "Applications",
      "gethomepage.dev/icon": "paperless-ngx",
      "gethomepage.dev/pod-selector": "app=paperless",
      "gethomepage.dev/href": "https://dms.mvissing.de",
      // Paperless widget - shows document counts
      "gethomepage.dev/widget.type": "paperlessngx",
      "gethomepage.dev/widget.url": "http://paperless.paperless.svc.cluster.local",
      "gethomepage.dev/widget.key": "{{HOMEPAGE_VAR_PAPERLESS_TOKEN}}",
    },
  },
  spec: {
    ingressClassName: "traefik",
    rules: [{
      host: "dms.mvissing.de",
      http: {
        paths: [{
          path: "/",
          pathType: "Prefix",
          backend: {
            service: {
              name: paperlessService.metadata.name,
              port: {
                number: 80,
              },
            },
          },
        }],
      },
    }],
    tls: [{
      secretName: "paperless-tls",
      hosts: ["dms.mvissing.de"],
    }],
  },
});

export {
  namespace as paperlessNamespace,
  paperlessDeployment,
  paperlessService,
  paperlessIngress,
  gotenbergDeployment,
  tikaDeployment,
};

// Setup instructions:
//
// 1. Add paperless role to PostgreSQL cluster (DONE in postgresql.ts)
//
// 2. Create NFS directory on maxdata:
//    sudo mkdir -p /tank/k8s/nfs/paperless-media
//    sudo chown -R 1000:1000 /tank/k8s/nfs/paperless-media
//
// 3. Configure Authentik OAuth2/OIDC Provider:
//    a. Go to Authentik UI (https://auth.mvissing.de)
//    b. Create new OAuth2/OpenID Provider:
//       - Name: Paperless-ngx
//       - Client type: Confidential
//       - Redirect URIs: https://dms.mvissing.de/accounts/authentik/login/callback/
//       - Signing Key: (auto-generated)
//    c. Create new Application:
//       - Name: Paperless-ngx
//       - Slug: paperless
//       - Provider: (select the provider created above)
//    d. Note the Client ID and Client Secret
//
// 4. Set Pulumi config secrets (before deploying):
//    cd ~/Git/setup/pulumi/k8s
//
//    # Generate a random secret key (or reuse existing one)
//    pulumi config set --secret paperless-secret-key "$(openssl rand -hex 32)"
//
//    # Set Authentik OAuth credentials from step 3
//    pulumi config set --secret paperless-authentik-client-id "YOUR_CLIENT_ID"
//    pulumi config set --secret paperless-authentik-client-secret "YOUR_CLIENT_SECRET"
//
// 5. Deploy with: pulumi up
//
// 6. Restore data from backup:
//    a. Restore PostgreSQL database:
//       kubectl cp paperless-backup.sql paperless/paperless-xxx:/tmp/
//       kubectl exec -it -n paperless paperless-xxx -- bash
//       psql -h postgres-rw.database.svc.cluster.local -U paperless -d paperless < /tmp/paperless-backup.sql
//
//    b. Restore data directory:
//       kubectl cp data/ paperless/paperless-xxx:/usr/src/paperless/data/
//
//    c. Restore media directory (to NFS on maxdata):
//       # On maxdata host:
//       rsync -av media/ /tank/k8s/nfs/paperless-media/
//       # Fix permissions:
//       sudo chown -R 1000:1000 /tank/k8s/nfs/paperless-media/
//
// 7. Set up DNS:
//    Point dms.mvissing.de to ionos public IP (A and AAAA records)
//
// 8. Access Paperless at: https://dms.mvissing.de
//    Login with Authentik SSO
//
// Architecture:
// - Paperless-ngx: Main web application (Django)
// - Gotenberg: Converts Office docs (docx, xlsx, etc.) to PDF
// - Tika: Extracts text and metadata from various document formats
// - PostgreSQL: Shared database cluster (CloudNativePG)
// - Redis: Shared cache and task queue
// - Storage:
//   * data: Local fast storage (search index, ML models) - 20Gi
//   * consume: Local fast storage (incoming docs queue) - 10Gi
//   * media: NFS on tank pool (bulk document archive) - 500Gi