// Authentik Outpost - Forward Auth Proxy
// Separate microservice for handling forward authentication requests from Traefik
// This allows independent scaling and better separation of concerns

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  authentikNamespace,
  authentikService,
  authentikServer,
} from "./authentik";

// Get configuration
const config = new pulumi.Config();

// Get Authentik Outpost Token from Pulumi config
// Set this with: pulumi config set --secret authentikOutpostToken <token>
// Note: You'll need to generate this token from the Authentik admin UI after initial setup
// Navigate to: Admin Interface → Applications → Outposts → Create → Copy the token
const outpostToken = config.requireSecret("authentikOutpostToken");

// Secret for Authentik Outpost Token
const outpostSecret = new k8s.core.v1.Secret("authentik-outpost-token", {
  metadata: {
    name: "authentik-outpost-token",
    namespace: authentikNamespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    token: outpostToken,
  },
});

// Authentik Outpost Deployment
const authentikOutpost = new k8s.apps.v1.Deployment(
  "authentik-outpost",
  {
    metadata: {
      name: "authentik-outpost",
      // ⚠️ This deliberately has **no** `pulumi.com/skipAwait`, and the
      // `dependsOn` below is what makes that safe. Both were one change.
      //
      // It used to skip the await, because the outpost health-checks itself
      // against the Authentik server and Pulumi awaiting its readiness deadlocked
      // the deploy: the outpost could not pass its probe until the server
      // existed, and the server was never created because the run was blocked
      // here. Observed as "[1/3] Finding Pods to direct traffic to" for 280+
      // seconds while authentik-server and authentik-worker were never created.
      //
      // But that was an ordering bug wearing an await bug's clothes, and skipping
      // the await cost more than it saved: `skipAwait` also stops Pulumi waiting
      // for the **delete** half of a replace. On 2026-08-07 a replace deleted
      // this Deployment, created it again, and the un-awaited delete then landed
      // on the *new* object — leaving Pulumi reporting `result=succeeded` with
      // nothing in the cluster, and state insisting it was there.
      //
      // Ordering it after the server fixes the deadlock at its source, so the
      // await can stay and actually tell us whether the outpost works. ⚠️ It will
      // now block if the outpost cannot reach Authentik — most likely a stale
      // `authentikOutpostToken`, which is a real failure and should be visible.
      namespace: authentikNamespace.metadata.name,
      labels: {
        app: "authentik-outpost",
        "app.kubernetes.io/name": "authentik-outpost",
        "app.kubernetes.io/component": "proxy",
      },
    },
    spec: {
      replicas: 1, // Temporarily using 1 replica for debugging
      selector: {
        matchLabels: {
          app: "authentik-outpost",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "authentik-outpost",
            "app.kubernetes.io/name": "authentik-outpost",
            "app.kubernetes.io/component": "proxy",
          },
        },
        spec: {
          containers: [
            {
              name: "authentik-proxy",
              image: "ghcr.io/goauthentik/proxy:2026.8.1",
              env: [
                {
                  name: "AUTHENTIK_HOST",
                  // In-cluster URL so outpost connectivity does not depend on the external ionos edge
                  value: "http://authentik.authentik.svc.cluster.local",
                },
                {
                  name: "AUTHENTIK_HOST_BROWSER",
                  // URL that browsers will use (public URL)
                  value: "https://auth.mvissing.de",
                },
                {
                  name: "AUTHENTIK_INSECURE",
                  value: "true",
                },
                {
                  name: "AUTHENTIK_TOKEN",
                  valueFrom: {
                    secretKeyRef: {
                      name: outpostSecret.metadata.name,
                      key: "token",
                    },
                  },
                },
                {
                  name: "AUTHENTIK_LOG_LEVEL",
                  value: "info",
                },
              ],
              ports: [
                {
                  containerPort: 9000,
                  name: "http",
                  protocol: "TCP",
                },
                {
                  containerPort: 9300,
                  name: "http-metrics",
                  protocol: "TCP",
                },
              ],
              volumeMounts: [
                {
                  name: "sessions",
                  mountPath: "/sessions",
                },
              ],
              livenessProbe: {
                httpGet: {
                  path: "/outpost.goauthentik.io/ping",
                  port: "http",
                },
                initialDelaySeconds: 30,
                periodSeconds: 10,
                timeoutSeconds: 3,
                failureThreshold: 3,
              },
              readinessProbe: {
                httpGet: {
                  path: "/outpost.goauthentik.io/ping",
                  port: "http",
                },
                initialDelaySeconds: 10,
                periodSeconds: 5,
                timeoutSeconds: 3,
                failureThreshold: 3,
              },
              resources: {
                requests: {
                  memory: "128Mi",
                  cpu: "100m",
                },
                limits: {
                  memory: "512Mi",
                  cpu: "500m",
                },
              },
            },
          ],
          volumes: [
            {
              name: "sessions",
              emptyDir: {},
            },
          ],
          // Distribute pods across nodes for better availability
          affinity: {
            podAntiAffinity: {
              preferredDuringSchedulingIgnoredDuringExecution: [
                {
                  weight: 100,
                  podAffinityTerm: {
                    labelSelector: {
                      matchLabels: {
                        app: "authentik-outpost",
                      },
                    },
                    topologyKey: "kubernetes.io/hostname",
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
  { dependsOn: [authentikServer] },
);

// Service for Authentik Outpost
const authentikOutpostService = new k8s.core.v1.Service(
  "authentik-outpost-service",
  {
    metadata: {
      name: "authentik-outpost",
      // Also no `skipAwait` — see the Deployment above. Pulumi awaits a
      // Service until it has endpoints, which cannot happen before the pods
      // behind it are ready, so this needs the Deployment ordered ahead of it
      // for the same reason the Deployment needs the server ordered ahead.
      namespace: authentikNamespace.metadata.name,
      labels: {
        app: "authentik-outpost",
        "app.kubernetes.io/name": "authentik-outpost",
        "app.kubernetes.io/component": "proxy",
      },
    },
    spec: {
      type: "ClusterIP",
      selector: {
        app: "authentik-outpost",
      },
      ports: [
        {
          port: 9000,
          targetPort: 9000,
          protocol: "TCP",
          name: "http",
        },
        {
          port: 9300,
          targetPort: 9300,
          protocol: "TCP",
          name: "http-metrics",
        },
      ],
    },
  },
  { dependsOn: [authentikOutpost] },
);

// Note: Outpost paths (/outpost.goauthentik.io/*) are now routed through the main
// Authentik ingress (defined in authentik.ts) to ensure consistent session handling
// between forward auth requests and OAuth callbacks.

export { authentikOutpost, authentikOutpostService, outpostSecret };

// Setup instructions for Domain-Level Forward Auth:
//
// 1. Deploy the main Authentik service first (done in authentik.ts)
//
// 2. Access Authentik admin UI at https://auth.mvissing.de
//    Login with: akadmin / <bootstrap password>
//    Get password: kubectl logs -n authentik deployment/authentik-server | grep "Bootstrap"
//
// 3. Create a Proxy Provider (Domain-Level):
//    a. Navigate to: Applications → Providers
//    b. Click "Create" → "Proxy Provider"
//    c. Configure:
//       - Name: "Forward Auth - Domain Level"
//       - Authorization flow: default-provider-authorization-implicit-consent
//       - Type: "Forward auth (domain level)"
//       - Cookie domain: ".mvissing.de" (with the leading dot for all subdomains)
//       - External host: "https://auth.mvissing.de" (your Authentik instance URL)
//    d. Save the provider
//
// 4. Create an Outpost:
//    a. Navigate to: Applications → Outposts
//    b. Click "Create"
//    c. Configure:
//       - Name: "k8s-forward-auth" (the live outpost record's UI name; the
//         k8s Deployment/Service this file creates is named authentik-outpost
//         — same outpost, two names in two places)
//       - Type: "Proxy"
//       - Integration: **`----` (none)**
//
//         ⚠️ NOT "Local Kubernetes Cluster", which this file used to say.
//         An outpost with a Kubernetes integration is one authentik manages
//         itself — it creates its own Deployment, Service and Secret named
//         `ak-outpost-<name>`. Picking it here gives you a second outpost
//         alongside the Pulumi-managed one in this file: two proxies for one
//         job, one of them invisible to the state file and un-diffable by
//         `pulumi preview`. Manual deployment is the whole point of this file.
//    d. In the "Applications" field, select the provider you created in step 3
//    e. After creation, copy the outpost integration token
//
// 5. Set the outpost token in Pulumi config (as a secret):
//    pulumi config set --secret authentikOutpostToken <YOUR_TOKEN_HERE>
//
// 6. Deploy the outpost:
//    pulumi up
//
// 7. Verify the outpost is connected:
//    - Check logs: kubectl logs -n authentik deployment/authentik-outpost
//    - In Authentik UI: Applications → Outposts → Status should show "Healthy"
//
// 8. (Optional) Create Applications for each protected service:
//    For better organization and per-app policies, create an Application for each service:
//    a. Navigate to: Applications → Applications
//    b. Click "Create"
//    c. Configure:
//       - Name: "Traefik Dashboard" (or service name)
//       - Slug: "traefik-dashboard"
//       - Provider: Select the domain-level provider from step 3
//    d. Repeat for other services you want to protect
//
// 9. Protect services with Traefik middleware:
//    Add the "authentik" middleware to any IngressRoute:
//    middlewares:
//      - name: authentik
//        namespace: traefik
//
// Note: To update the token later:
//    pulumi config set --secret authentikOutpostToken <NEW_TOKEN>
//    pulumi up
//
// How it works (Domain-Level):
// - The outpost connects to the main Authentik server using the token
// - Traefik forwards authentication requests to the outpost for ANY service using the middleware
// - The outpost validates credentials against Authentik
// - Authentication cookies are set for the entire domain (.mvissing.de)
// - Users authenticate once and can access all protected services under the domain
// - Protected services receive validated user information in request headers
