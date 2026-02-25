// Grafana - Visualization and dashboards
// Integrates with Prometheus, Loki, and Tempo
// Uses Authentik for OAuth authentication
// Accessible via grafana.mvissing.de

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { namespaceName } from "./namespace";
import { prometheusUrl } from "./prometheus";
import { lokiUrl } from "./loki";
import { tempoQueryUrl } from "./tempo";
import {
  grafanaDatabaseHost,
  grafanaDatabaseName,
  grafanaDatabaseUser,
  grafanaDatabaseSecretName,
} from "./grafana-database";

// Get Pulumi config for Authentik OAuth credentials
const config = new pulumi.Config();
const authentikClientId = config.requireSecret("grafana-oauth-client-id");
const authentikClientSecret = config.requireSecret("grafana-oauth-client-secret");
const authentikUrl = "https://auth.mvissing.de";

// Generate random password for Grafana admin user
const grafanaAdminPassword = new random.RandomPassword("grafana-admin-password", {
  length: 16,
  special: false,
});

// Install Grafana using Helm chart
const grafana = new k8s.helm.v3.Chart("grafana", {
  chart: "grafana",
  version: "10.3.0",
  namespace: namespaceName,
  fetchOpts: {
    repo: "https://grafana.github.io/helm-charts",
  },
  values: {
    // Persistent storage for plugins only (dashboards/config now in PostgreSQL)
    persistence: {
      enabled: true,
      storageClassName: "local-path",
      size: "2Gi", // Reduced size - only for plugins and temporary files
    },

    // Disable init-chown-data container (not needed and causes permission issues)
    initChownData: {
      enabled: false,
    },

    // Environment variables for database connection
    envFromSecret: grafanaDatabaseSecretName,

    // Additional environment variables
    env: {
      GF_SECURITY_ADMIN_USER: "admin",
      GF_SECURITY_ADMIN_PASSWORD: grafanaAdminPassword.result,
      GF_AUTH_GENERIC_OAUTH_CLIENT_ID: authentikClientId,
      GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET: authentikClientSecret,
    },

    // Resource limits
    resources: {
      requests: {
        cpu: "250m",
        memory: "512Mi",
      },
      limits: {
        cpu: "1",
        memory: "1Gi",
      },
    },

    // Ingress configuration
    ingress: {
      enabled: true,
      ingressClassName: "traefik",  // Changed from traefik-external - now using port forwarding on ionos
      annotations: {
        "cert-manager.io/cluster-issuer": "letsencrypt-prod",
        // Homepage dashboard discovery
        "gethomepage.dev/enabled": "true",
        "gethomepage.dev/name": "Grafana",
        "gethomepage.dev/description": "Dashboards & Visualization",
        "gethomepage.dev/group": "Monitoring",
        "gethomepage.dev/icon": "grafana",
        "gethomepage.dev/href": "https://grafana.mvissing.de",
        // Grafana widget - shows dashboard and alert stats
        "gethomepage.dev/widget.type": "grafana",
        "gethomepage.dev/widget.url": "http://grafana.monitoring.svc.cluster.local",
        "gethomepage.dev/widget.username": "admin",
        "gethomepage.dev/widget.password": '{{ "{{HOMEPAGE_VAR_GRAFANA_PASSWORD}}" }}',
      },
      hosts: ["grafana.mvissing.de"],
      tls: [
        {
          secretName: "grafana-tls",
          hosts: ["grafana.mvissing.de"],
        },
      ],
    },

    // Grafana configuration
    "grafana.ini": {
      server: {
        root_url: "https://grafana.mvissing.de",
        serve_from_sub_path: false,
      },

      // Database configuration - PostgreSQL
      database: {
        type: "postgres",
        host: `${grafanaDatabaseHost}:5432`,
        name: grafanaDatabaseName,
        user: grafanaDatabaseUser,
        password: "$__env{password}", // From envFromSecret
        ssl_mode: "disable", // Internal cluster communication
      },

      // OAuth configuration with Authentik
      "auth.generic_oauth": {
        enabled: true,
        name: "Authentik",
        // client_id and client_secret set via env vars (GF_AUTH_GENERIC_OAUTH_CLIENT_ID/SECRET)
        scopes: "openid email profile",
        auth_url: `${authentikUrl}/application/o/authorize/`,
        token_url: `${authentikUrl}/application/o/token/`,
        api_url: `${authentikUrl}/application/o/userinfo/`,
        // Role mapping from Authentik groups
        role_attribute_path: "contains(groups, 'Grafana Admins') && 'Admin' || contains(groups, 'Grafana Editors') && 'Editor' || 'Viewer'",
        allow_sign_up: true,
        auto_login: false, // Set to true to skip Grafana login page
      },

      // Anonymous access - disabled
      "auth.anonymous": {
        enabled: false,
      },

      // Security settings
      security: {
        admin_user: "admin",
        // admin_password set via GF_SECURITY_ADMIN_PASSWORD env var
      },

      // Analytics - disabled
      analytics: {
        reporting_enabled: false,
        check_for_updates: false,
      },
    },

    // Pre-configured data sources
    datasources: {
      "datasources.yaml": {
        apiVersion: 1,
        datasources: [
          {
            name: "Prometheus",
            type: "prometheus",
            access: "proxy",
            url: prometheusUrl,
            isDefault: true,
            editable: true,
            jsonData: {
              httpMethod: "POST",
              timeInterval: "30s",
            },
          },
          {
            name: "Loki",
            type: "loki",
            access: "proxy",
            url: lokiUrl,
            editable: true,
          },
          {
            name: "Tempo",
            type: "tempo",
            access: "proxy",
            url: tempoQueryUrl,
            editable: true,
          },
        ],
      },
    },

    // Dashboard providers
    dashboardProviders: {
      "dashboardproviders.yaml": {
        apiVersion: 1,
        providers: [
          {
            name: "default",
            orgId: 1,
            folder: "",
            type: "file",
            disableDeletion: false,
            editable: true,
            options: {
              path: "/var/lib/grafana/dashboards/default",
            },
          },
        ],
      },
    },

    // Pre-installed dashboards
    dashboards: {
      default: {
        // Kubernetes cluster monitoring
        "kubernetes-cluster": {
          gnetId: 7249, // Kubernetes Cluster (Prometheus)
          revision: 1,
          datasource: "Prometheus",
        },
        // Node exporter full
        "node-exporter": {
          gnetId: 1860, // Node Exporter Full
          revision: 37,
          datasource: "Prometheus",
        },
        // Kubernetes pod monitoring
        "kubernetes-pods": {
          gnetId: 6417, // Kubernetes Pods
          revision: 1,
          datasource: "Prometheus",
        },
        // Loki dashboard
        "loki-dashboard": {
          gnetId: 13639, // Logs / App
          revision: 2,
          datasource: "Loki",
        },
      },
    },

    // Plugins to install
    plugins: [
      // Additional useful plugins can be added here
    ],

    // Service configuration
    service: {
      type: "ClusterIP",
      port: 80,
    },

    // Enable RBAC
    rbac: {
      create: true,
      pspEnabled: false,
    },

    // Service account
    serviceAccount: {
      create: true,
    },
  },
});

// Export Grafana admin password as output
export const adminPassword = grafanaAdminPassword.result;

export { grafana };

// Post-deployment setup required:
//
// 1. Create OAuth2/OIDC Provider in Authentik:
//    - Go to Authentik Admin UI → Applications → Providers
//    - Click "Create" → OAuth2/OpenID Provider
//    - Name: Grafana
//    - Authorization flow: default-provider-authorization-implicit-consent
//    - Client type: Confidential
//    - Client ID: <generate or use a custom value>
//    - Client Secret: <generate>
//    - Redirect URIs: https://grafana.mvissing.de/login/generic_oauth
//    - Signing Key: authentik Self-signed Certificate
//
// 2. Create Application in Authentik:
//    - Go to Applications → Create
//    - Name: Grafana
//    - Slug: grafana
//    - Provider: Select the provider created above
//    - Launch URL: https://grafana.mvissing.de
//
// 3. (Optional) Create Groups for role mapping:
//    - "Grafana Admins" → Full admin access
//    - "Grafana Editors" → Can edit dashboards
//    - Default: Viewer access
//
// 4. Add OAuth credentials to Pulumi config:
//    pulumi config set --secret grafana-oauth-client-id <client-id>
//    pulumi config set --secret grafana-oauth-client-secret <client-secret>
//
// 5. Deploy:
//    pulumi up
//
// Access Grafana:
//   URL: https://grafana.mvissing.de
//   Login: Click "Sign in with Authentik" or use admin/password as fallback
//
// The admin password is auto-generated and shown in Pulumi outputs:
//   pulumi stack output adminPassword --show-secrets
//
// Database:
//   Grafana uses PostgreSQL for storing:
//   - Dashboards and folder structure
//   - User accounts and preferences
//   - Data sources configuration
//   - Alert rules and notifications
//   - API keys and sessions
//
//   Database: grafana.postgres-rw.database.svc.cluster.local:5432
//   Backed up via ZFS snapshots (same as other PostgreSQL data)
//
// Pre-configured data sources:
//   - Prometheus (default): Metrics from your cluster
//   - Loki: Logs from all pods
//   - Tempo: Distributed traces
//
// Pre-installed dashboards:
//   - Kubernetes Cluster monitoring
//   - Node Exporter metrics
//   - Kubernetes Pods
//   - Loki logs viewer