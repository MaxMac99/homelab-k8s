// Paperless-ngx - Document Management System
// Uses shared PostgreSQL and Redis instances
// Includes Gotenberg (Office conversion) and Tika (text extraction)
// Media storage on NFS (tank pool), data/consume on fast local storage

import * as k8s from "@pulumi/kubernetes";
import * as authentik from "@pulumi/authentik";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

// Import shared service connection info
import {
  postgresqlNamespace,
  postgresWinkelHost,
  postgresWinkelClusterName,
} from "../databases/postgresql";
import { redisHost } from "../databases/redis";
import { onNode, winkelSite, MAXDATA } from "../infrastructure/sites";
import {
  defaultAuthorizationFlow,
  defaultInvalidationFlow,
  oauth2ScopeMappings,
  signingKey,
} from "../auth/authentik-config";
import { adminsGroup } from "../auth/authentik-directory";

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
const metricsApiToken = config.requireSecret("paperless-metrics-api-token");

// ---------------------------------------------------------------------------
// Authentik OIDC — provider and application managed here since the
// config-as-code adoption (authentik/* for the pattern). The client
// credentials flow from the provider resource: `clientId` is public,
// `clientSecret` is a secret output captured at import time. The stack-config
// copies (paperless-authentik-client-id/secret) were removed when this
// landed. The redirect URI below must stay in sync with the login callback
// path allauth builds — see the setup notes at the bottom of this file.
const paperlessOauth2Provider = new authentik.ProviderOauth2(
  "paperless-oauth2-provider",
  {
    name: "Paperless-ngx",
    clientId: "oJ9jbLXmdJnb1gp5BpP37y5u5UUhG8gcFkwChDfF",
    authorizationFlow: defaultAuthorizationFlow.id,
    invalidationFlow: defaultInvalidationFlow.id,
    propertyMappings: oauth2ScopeMappings,
    signingKey,
    // ⚠️ Snake_case map keys — see apps/immich.ts.
    allowedRedirectUris: [
      {
        matching_mode: "strict",
        url: "https://dms.mvissing.de/accounts/oidc/authentik/login/callback/",
        redirect_uri_type: "authorization",
      },
    ],
    // Non-default validity — everything else is the provider default.
    accessTokenValidity: "minutes=5",
    refreshTokenThreshold: "hours=1",
  },
);

const paperlessApplication = new authentik.Application(
  "paperless-application",
  {
    name: "Paperless-ngx",
    slug: "paperless",
    protocolProvider: paperlessOauth2Provider.providerOauth2Id.apply(Number),
    metaLaunchUrl: "https://dms.mvissing.de",
  },
);

// The authorization gate: admins only (the estate pattern).
new authentik.PolicyBinding("paperless-group-binding", {
  target: paperlessApplication.uuid,
  group: adminsGroup.id,
  order: 0,
});

const authentikClientId = paperlessOauth2Provider.clientId;
const authentikClientSecret = paperlessOauth2Provider.clientSecret;

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
    PAPERLESS_SOCIALACCOUNT_PROVIDERS: pulumi
      .all([authentikClientId, authentikClientSecret])
      .apply(([clientId, clientSecret]) =>
        JSON.stringify({
          openid_connect: {
            SERVERS: [
              {
                id: "authentik",
                name: "Authentik",
                server_url:
                  "https://auth.mvissing.de/application/o/paperless/.well-known/openid-configuration",
                token_auth_method: "client_secret_basic",
                APP: {
                  client_id: clientId,
                  secret: clientSecret,
                },
              },
            ],
          },
        }),
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

// Declaratively manage the Paperless database on the Winkel cluster.
//
// ⚠️ Named `paperless-winkel-db`, not `paperless-db`: `Database.spec.cluster`
// is immutable ("cluster reference is immutable after creation"), so the move
// to another cluster is a new object plus removal of the old one rather than an
// edit. The database itself arrives via `postgres-winkel`'s bootstrap import;
// this adopts it. The old CR going away does not drop the Brink copy — its
// reclaim policy is `retain`, deliberately, so a rollback exists.
const paperlessDatabase = new k8s.apiextensions.CustomResource(
  "paperless-database-winkel",
  {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Database",
    metadata: {
      name: "paperless-winkel-db",
      namespace: postgresqlNamespace,
    },
    spec: {
      name: "paperless",
      owner: "paperless",
      cluster: {
        name: postgresWinkelClusterName,
      },
      databaseReclaimPolicy: "retain",
    },
  },
);

// NFS Persistent Volume for media storage (on tank pool)
//
// ⚠️ `storageClassName: "nfs"` names no real StorageClass, and that is correct.
// `kubectl get sc` lists only `local-path`. For a *static* bind the class name
// is just a matching key between PV and PVC — `volumeName` below does the
// binding and no provisioner is involved. Time Machine does the same under
// `nfs-storage`. Do not "fix" this by adding an NFS provisioner.
//
// ⚠️ This media survives a cluster rebuild: it lives on `tank`, which the
// Phase 7 rebuild never touched. Do not restore nfs-paperless-media.tar.gz over
// a live directory — verify against the DB dump's `filename` column first.
const paperlessMediaPV = new k8s.core.v1.PersistentVolume(
  "paperless-media-pv",
  {
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
      mountOptions: ["nfsvers=4.2", "hard", "intr"],
      nfs: {
        server: "192.168.178.2", // maxdata NFS server
        path: "/tank/k8s/nfs/paperless-media",
      },
    },
  },
);

// PVC for NFS media storage
const paperlessMediaPVC = new k8s.core.v1.PersistentVolumeClaim(
  "paperless-media-pvc",
  {
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
  },
);

// PVC for data storage (search index, ML models, cache)
const paperlessDataPVC = new k8s.core.v1.PersistentVolumeClaim(
  "paperless-data-pvc",
  {
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
  },
);

// PVC for consume directory (incoming documents)
const paperlessConsumePVC = new k8s.core.v1.PersistentVolumeClaim(
  "paperless-consume-pvc",
  {
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
  },
);

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
        // Stateless, but kept at Winkel: Paperless calls these synchronously
        // for every document, so a pod at Brink would put the WAN overlay in
        // the middle of each OCR and conversion.
        nodeSelector: winkelSite,
        containers: [
          {
            name: "gotenberg",
            image: "gotenberg/gotenberg:8.37.0",
            ports: [
              {
                containerPort: 3000,
                name: "http",
              },
            ],
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
          },
        ],
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
    ports: [
      {
        port: 3000,
        targetPort: 3000,
        name: "http",
      },
    ],
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
        // Stateless, but kept at Winkel: Paperless calls these synchronously
        // for every document, so a pod at Brink would put the WAN overlay in
        // the middle of each OCR and conversion.
        nodeSelector: winkelSite,
        containers: [
          {
            name: "tika",
            image: "apache/tika:3.3.1.0",
            ports: [
              {
                containerPort: 9998,
                name: "http",
              },
            ],
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
          },
        ],
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
    ports: [
      {
        port: 9998,
        targetPort: 9998,
        name: "http",
      },
    ],
  },
});

// Paperless-ngx Deployment
const paperlessDeployment = new k8s.apps.v1.Deployment(
  "paperless",
  {
    metadata: {
      name: "paperless",
      namespace: namespace.metadata.name,
    },
    spec: {
      replicas: 1,
      strategy: {
        type: "RollingUpdate",
        rollingUpdate: {
          maxUnavailable: 1,
          maxSurge: 0,
        },
      },
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
            "prometheus.io/port": "9999", // Metrics exporter sidecar
            "prometheus.io/path": "/metrics",
          },
        },
        spec: {
          // Pinned to maxdata. Paperless holds two local-path PVCs (data and
          // consume) alongside its NFS media share, and NFS is served by this
          // same node — so anywhere else means node-local volumes that do not
          // follow it plus a WAN hop for every document read.
          nodeSelector: onNode(MAXDATA),
          containers: [
            {
              name: "paperless",
              image: "ghcr.io/paperless-ngx/paperless-ngx:3.0.0-beta.rc1",
              ports: [
                {
                  containerPort: 8000,
                  name: "http",
                },
              ],
              env: [
                // Database configuration
                {
                  name: "PAPERLESS_DBHOST",
                  value: postgresWinkelHost,
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
                  value:
                    "dms.mvissing.de,paperless.paperless.svc.cluster.local",
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
                // ⚠️ These three together can lock you out of a restored
                // archive while looking like a completely successful login.
                //
                // Authentik's OIDC `sub` is installation-scoped — under the
                // default sub_mode it is sha256("<user id>-<installation
                // identifier>") — so every `socialaccount_socialaccount` row in
                // a restored Paperless dump carries a subject from the *old*
                // Authentik and can never match a rebuilt one. AUTO_SIGNUP then
                // creates a brand-new user on first SSO login, owning none of
                // the documents, while DISABLE_REGULAR_LOGIN removes the way
                // back — and every user in the dump has a Django *unusable*
                // password, so there is no local superuser to fall back on.
                // The result is an empty document list, not an error.
                //
                // After restoring a dump beside a rebuilt Authentik, read the
                // new subject out of Authentik and fix the link *before* the
                // first login:
                //
                //   kubectl exec -n authentik deploy/authentik-server -- \
                //     ak shell -c "from authentik.core.models import User; \
                //                  print(User.objects.get(username='Max').uid)"
                //   UPDATE socialaccount_socialaccount SET uid = '<that>'
                //    WHERE user_id = <paperless user> AND provider = 'authentik';
                //
                // See docs/multi-site-migration.md §10.2 in the `setup` repo.
                //
                // Off since 2026-08-08, once the restored link was confirmed
                // working. It exists to bootstrap the *first* SSO user, and
                // that is done — leaving it on means any Authentik account
                // that reaches dms.mvissing.de silently gets a Paperless
                // account. With it off, a subject that does not match an
                // existing link fails the login visibly instead of quietly
                // creating a second, empty-looking archive.
                //
                // ⚠️ Turn it back on temporarily to onboard a new person, or
                // pre-create the socialaccount row as described above.
                {
                  name: "PAPERLESS_SOCIAL_AUTO_SIGNUP",
                  value: "False",
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
              image: "ghcr.io/hansmi/prometheus-paperless-exporter:v0.0.10",
              args: ["--web.listen-address=:9999"],
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
              ports: [
                {
                  containerPort: 9999,
                  name: "metrics",
                },
              ],
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
            },
          ],
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
  },
  { dependsOn: [paperlessDatabase, gotenbergDeployment, tikaDeployment] },
);

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
    ports: [
      {
        port: 80,
        targetPort: 8000,
        name: "http",
      },
    ],
  },
});

// Ingress for Paperless (both internal and external access)
const paperlessIngress = new k8s.networking.v1.Ingress("paperless-ingress", {
  metadata: {
    name: "paperless",
    namespace: namespace.metadata.name,
    annotations: {
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "cert-manager.io/cluster-issuer": activeClusterIssuer,
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
      "gethomepage.dev/widget.url":
        "http://paperless.paperless.svc.cluster.local",
      "gethomepage.dev/widget.key": "{{HOMEPAGE_VAR_PAPERLESS_TOKEN}}",
    },
  },
  spec: {
    ingressClassName: "traefik",
    rules: [
      {
        host: "dms.mvissing.de",
        http: {
          paths: [
            {
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
            },
          ],
        },
      },
    ],
    tls: [
      {
        secretName: "paperless-tls",
        hosts: ["dms.mvissing.de"],
      },
    ],
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
// 3. Authentik OAuth2/OIDC — now code, not clicks: the provider and
//    application are declared in this file (see the Authentik OIDC section),
//    managed through the API provider configured by authentik:url /
//    authentik:token in stack config (see auth/authentik-config.ts). The
//    client credentials flow from the provider resource itself.
//
//    ⚠️ Note the `/oidc/` segment in the redirect URI. This file previously
//    documented `/accounts/authentik/login/callback/`, which Authentik rejects
//    with "The request fails due to a missing, invalid, or mismatching
//    redirection URI". allauth namespaces the openid_connect provider under
//    `/accounts/oidc/<provider_id>/`, where <provider_id> is the `id` field in
//    PAPERLESS_SOCIALACCOUNT_PROVIDERS above ("authentik"). Do not guess it —
//    ask Django, which is what actually builds the URL:
//
//      kubectl exec -n paperless deploy/paperless -c paperless -- python3 -c \
//        "import django,os; os.environ.setdefault('DJANGO_SETTINGS_MODULE','paperless.settings'); \
//         django.setup(); from django.urls import get_resolver; \
//         print([str(p.pattern) for p in get_resolver().url_patterns])"
//
//    (Historical: this provider was once created via `ak shell`, which left
//    `grant_types` empty — a serializer default, not a model default — and
//    every callback failed with error=invalid_request. It now lives in code
//    where the field list is explicit.)
//
// 4. Set Pulumi config secrets (before deploying):
//    # Generate a random secret key (or reuse the existing one)
//    pulumi config set --secret paperless-secret-key "$(openssl rand -hex 32)"
//
// 5. ⚠️ RESTORE THE DATABASE BEFORE THE FIRST DEPLOY. Paperless migrates an
//    empty database on first start, and the dump then collides with the schema
//    it created. The CNPG `Database` CR above creates an empty database; load
//    into that, stripping the dump's own CREATE DATABASE preamble:
//
//      gzip -dc pg-paperless.sql.gz \
//        | sed '1,/^\\connect paperless$/d' \
//        | kubectl exec -i -n database postgres-1 -c postgres -- \
//            psql -U postgres -d paperless -v ON_ERROR_STOP=1
//
//    Do NOT load pg-globals.sql.gz — CNPG owns the roles and their passwords.
//
// 6. Fix the SSO link before the first login (see the block by
//    PAPERLESS_SOCIAL_AUTO_SIGNUP above — this is the step that silently
//    strands the archive if skipped).
//
// 7. Deploy: pulumi up --exclude '**unifi**'      (never --target)
//
// 8. Rebuild the search index and classifier — the `data` PVC is empty on a
//    rebuild, so search returns nothing until this runs. The 149 M
//    localpath-paperless-data.tar.gz is NOT worth restoring; this is faster.
//
//      kubectl exec -n paperless deploy/paperless -c paperless -- document_index reindex
//      kubectl exec -n paperless deploy/paperless -c paperless -- document_create_classifier
//
// 9. Verify by effect, not by pod status:
//      kubectl get pvc -n paperless      # paperless-media must be Bound
//      kubectl exec ... -- curl -s localhost:9999/metrics | grep paperless_documents
//      curl https://dms.mvissing.de/     # without -k; the cert must be real
//
// 10. DNS: dms.mvissing.de resolves to the site ingress VIP via AdGuard's
//     split-horizon rewrite, NOT to the ionos public IP — the public edge is
//     default-closed and answers 404.
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
//   * media: NFS on tank pool (bulk document archive) - 300Gi
