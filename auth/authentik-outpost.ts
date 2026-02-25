// Authentik Outpost - Forward Auth Proxy
// Separate microservice for handling forward authentication requests from Traefik
// This allows independent scaling and better separation of concerns

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { authentikNamespace, authentikService } from "./authentik";

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
const authentikOutpost = new k8s.apps.v1.Deployment("authentik-outpost", {
  metadata: {
    name: "authentik-outpost",
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
        containers: [{
          name: "authentik-proxy",
          image: "ghcr.io/goauthentik/proxy:2025.10.2",
          env: [
            {
              name: "AUTHENTIK_HOST",
              // Use the public URL - outpost uses this for redirect URLs sent to browsers
              value: "https://auth.mvissing.de",
            },
            {
              name: "AUTHENTIK_HOST_BROWSER",
              // URL that browsers will use (public URL)
              value: "https://auth.mvissing.de",
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
          volumeMounts: [{
            name: "sessions",
            mountPath: "/sessions",
          }],
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
        }],
        volumes: [{
          name: "sessions",
          emptyDir: {},
        }],
        // Distribute pods across nodes for better availability
        affinity: {
          podAntiAffinity: {
            preferredDuringSchedulingIgnoredDuringExecution: [{
              weight: 100,
              podAffinityTerm: {
                labelSelector: {
                  matchLabels: {
                    app: "authentik-outpost",
                  },
                },
                topologyKey: "kubernetes.io/hostname",
              },
            }],
          },
        },
      },
    },
  },
});

// Service for Authentik Outpost
const authentikOutpostService = new k8s.core.v1.Service("authentik-outpost-service", {
  metadata: {
    name: "authentik-outpost",
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
});

// Note: Outpost paths (/outpost.goauthentik.io/*) are now routed through the main
// Authentik ingress (defined in authentik.ts) to ensure consistent session handling
// between forward auth requests and OAuth callbacks.

export {
  authentikOutpost,
  authentikOutpostService,
  outpostSecret,
};

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
//       - Name: "Kubernetes Forward Auth"
//       - Type: "Proxy"
//       - Integration: "Local Kubernetes Cluster" (or create a new integration)
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