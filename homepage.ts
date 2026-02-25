// Homepage - Modern dashboard for homelab
// A highly customizable application dashboard with Kubernetes integration
// Protected by Authentik forward auth
// Accessible via mvissing.de

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { adminPassword as grafanaAdminPassword } from "./monitoring/grafana";

const config = new pulumi.Config();
const authentikApiToken = config.requireSecret("authentikApiToken");
const paperlessApiToken = config.requireSecret("paperless-metrics-api-token");
const proxmoxUser = config.requireSecret("proxmox-api-user");       // Format: user@pam!tokenid
const proxmoxToken = config.requireSecret("proxmox-api-token");     // API token secret

// Create namespace for Homepage
const homepageNamespace = new k8s.core.v1.Namespace("homepage", {
  metadata: {
    name: "homepage",
  },
});

// Secret for widget API tokens and credentials
// Authentik: Create API token in Admin Portal -> Directory -> Tokens & App passwords
//            User must have permissions: "Can view User" and "Can view Event"
// Grafana: Uses auto-generated admin password from monitoring/grafana.ts
// Paperless: Uses the same metrics API token from paperless-metrics-api-token config
// Proxmox: Create API token in Datacenter -> Permissions -> API Tokens
const homepageSecrets = new k8s.core.v1.Secret("homepage-secrets", {
  metadata: {
    name: "homepage-secrets",
    namespace: homepageNamespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    HOMEPAGE_VAR_AUTHENTIK_TOKEN: authentikApiToken,
    HOMEPAGE_VAR_GRAFANA_PASSWORD: grafanaAdminPassword,
    HOMEPAGE_VAR_PAPERLESS_TOKEN: paperlessApiToken,
    HOMEPAGE_VAR_PROXMOX_USER: proxmoxUser,
    HOMEPAGE_VAR_PROXMOX_TOKEN: proxmoxToken,
  },
});

// ClusterRole for cluster-wide service discovery (ingresses across all namespaces)
const homepageClusterRole = new k8s.rbac.v1.ClusterRole("homepage-cluster-role", {
  metadata: {
    name: "homepage",
  },
  rules: [
    {
      apiGroups: [""],
      resources: ["namespaces", "pods", "nodes"],
      verbs: ["get", "list"],
    },
    {
      apiGroups: ["extensions", "networking.k8s.io"],
      resources: ["ingresses"],
      verbs: ["get", "list"],
    },
    {
      apiGroups: ["traefik.io", "traefik.containo.us"],
      resources: ["ingressroutes"],
      verbs: ["get", "list"],
    },
    {
      apiGroups: ["metrics.k8s.io"],
      resources: ["nodes", "pods"],
      verbs: ["get", "list"],
    },
  ],
});

// ClusterRoleBinding to allow homepage service account to use the ClusterRole
const homepageClusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding("homepage-cluster-role-binding", {
  metadata: {
    name: "homepage",
  },
  roleRef: {
    apiGroup: "rbac.authorization.k8s.io",
    kind: "ClusterRole",
    name: homepageClusterRole.metadata.name,
  },
  subjects: [{
    kind: "ServiceAccount",
    name: "homepage",
    namespace: homepageNamespace.metadata.name,
  }],
}, { dependsOn: [homepageClusterRole, homepageNamespace] });

// Install Homepage using Helm chart
const homepage = new k8s.helm.v3.Chart(
  "homepage",
  {
    chart: "homepage",
    version: "2.1.0",
    namespace: homepageNamespace.metadata.name,
    fetchOpts: {
      repo: "https://jameswynn.github.io/helm-charts",
    },
    values: {
      image: {
        repository: "ghcr.io/gethomepage/homepage",
        tag: "v1.7.0",
      },

      // Disable helm chart RBAC - we create our own ClusterRole with broader permissions
      enableRbac: false,

      // Service account for Kubernetes API access
      serviceAccount: {
        create: true,
        name: "homepage",
      },

      // Service configuration
      service: {
        main: {
          ports: {
            http: {
              port: 3000,
            },
          },
        },
      },

      // Ingress configuration with Authentik forward auth
      ingress: {
        main: {
          enabled: true,
          ingressClassName: "traefik",
          annotations: {
            "cert-manager.io/cluster-issuer": "letsencrypt-prod",
            // Protect with Authentik forward auth middleware
            "traefik.ingress.kubernetes.io/router.middlewares": "traefik-authentik@kubernetescrd",
          },
          hosts: [
            {
              host: "mvissing.de",
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                },
              ],
            },
          ],
          tls: [
            {
              secretName: "homepage-tls",
              hosts: ["mvissing.de"],
            },
          ],
        },
      },

      // Configuration
      config: {
        // No bookmarks
        bookmarks: [],

        // Services - mix of manual and auto-discovered from Kubernetes
        services: [
          {
            Infrastructure: [
              {
                "Fritz!Box": {
                  icon: "fritzbox",
                  href: "http://192.168.178.1",
                  description: "Router",
                  widget: {
                    type: "fritzbox",
                    url: "http://192.168.178.1",
                    fields: [
                      "connectionStatus",
                      "maxDown",
                      "maxUp",
                    ],
                  },
                },
              },
              {
                "Proxmox": {
                  icon: "proxmox",
                  href: "https://192.168.178.2:8006",
                  description: "Hypervisor",
                  widget: {
                    type: "proxmox",
                    url: "https://192.168.178.2:8006",
                    username: "{{HOMEPAGE_VAR_PROXMOX_USER}}",
                    password: "{{HOMEPAGE_VAR_PROXMOX_TOKEN}}",
                  },
                },
              },
              {
                "Cockpit": {
                  icon: "cockpit",
                  href: "https://192.168.178.2:9090",
                  description: "Server Management",
                },
              },
            ],
          },
        ],

        // Widgets for dashboard
        widgets: [
          {
            resources: {
              cpu: true,
              memory: true,
              disk: "/",
            },
          },
          {
            kubernetes: {
              cluster: {
                show: true,
                cpu: true,
                memory: true,
                showLabel: true,
                label: "cluster",
              },
              nodes: {
                show: true,
                cpu: true,
                memory: true,
                showLabel: true,
              },
            },
          },
        ],

        // Kubernetes integration - discover services from annotations
        kubernetes: {
          mode: "cluster",
          traefik: true, // Enable Traefik IngressRoute discovery
        },

        // Settings
        settings: {
          title: "Home",
          headerStyle: "clean",
          layout: {
            Infrastructure: {
              style: "row",
              columns: 3,
            },
            Monitoring: {
              style: "row",
              columns: 3,
            },
            Applications: {
              style: "row",
              columns: 3,
            },
          },
        },
      },

      // Environment variables
      env: {
        HOMEPAGE_ALLOWED_HOSTS: "mvissing.de",
      },

      // Load widget API tokens from secret
      envFrom: [
        {
          secretRef: {
            name: "homepage-secrets",
          },
        },
      ],

      // Resource limits
      resources: {
        requests: {
          cpu: "50m",
          memory: "128Mi",
        },
        limits: {
          cpu: "500m",
          memory: "256Mi",
        },
      },
    },
  },
  { dependsOn: [homepageNamespace, homepageSecrets] }
);

export { homepage, homepageNamespace };

// Post-deployment setup required:
//
// 1. Create Proxy Provider in Authentik:
//    - Go to Authentik Admin UI -> Applications -> Providers
//    - Click "Create" -> Proxy Provider
//    - Name: Homepage
//    - Authorization flow: default-provider-authorization-implicit-consent
//    - Forward auth (domain level)
//    - External host: https://mvissing.de
//
// 2. Create Application in Authentik:
//    - Go to Applications -> Create
//    - Name: Homepage
//    - Slug: homepage
//    - Provider: Select the proxy provider created above
//    - Launch URL: https://mvissing.de
//
// 3. Add to Outpost:
//    - Go to Applications -> Outposts -> authentik-outpost
//    - Add the Homepage application to the outpost
//
// Access Homepage:
//   URL: https://mvissing.de
//   Authentication: Via Authentik SSO
//
// Service Discovery:
//   Homepage auto-discovers services from Kubernetes ingresses that have
//   gethomepage.dev/* annotations. Add these annotations to any ingress:
//     gethomepage.dev/enabled: "true"
//     gethomepage.dev/name: "Service Name"
//     gethomepage.dev/description: "Description"
//     gethomepage.dev/group: "Group Name"
//     gethomepage.dev/icon: "icon-name"