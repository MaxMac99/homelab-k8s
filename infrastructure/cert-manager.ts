// cert-manager - Automatic TLS certificate management
// Automatically provisions and renews Let's Encrypt certificates
// Works with Traefik ingress to provide HTTPS

import * as k8s from "@pulumi/kubernetes";

// Create namespace for cert-manager
const namespace = new k8s.core.v1.Namespace("cert-manager", {
  metadata: {
    name: "cert-manager",
  },
});

// Install cert-manager via Helm
const certManager = new k8s.helm.v3.Chart("cert-manager", {
  chart: "cert-manager",
  version: "v1.19.4",
  namespace: namespace.metadata.name,
  fetchOpts: {
    repo: "https://charts.jetstack.io",
  },
  values: {
    // Install CRDs automatically
    installCRDs: true,

    // Prometheus monitoring
    prometheus: {
      enabled: true,
    },

    // JSON logging for all components
    config: {
      apiVersion: "controller.config.cert-manager.io/v1alpha1",
      kind: "ControllerConfiguration",
      logging: {
        format: "json",
      },
    },
    webhook: {
      extraArgs: ["--logging-format=json"],
    },
    cainjector: {
      extraArgs: ["--logging-format=json"],
    },
  },
});

// ClusterIssuer for Let's Encrypt Production
// This will issue real, trusted certificates
const letsencryptProd = new k8s.apiextensions.CustomResource("letsencrypt-prod", {
  apiVersion: "cert-manager.io/v1",
  kind: "ClusterIssuer",
  metadata: {
    name: "letsencrypt-prod",
  },
  spec: {
    acme: {
      // Let's Encrypt production server
      server: "https://acme-v02.api.letsencrypt.org/directory",

      // Email for certificate expiration notifications
      email: "max_vissing@yahoo.de",

      // Store the ACME account private key in this secret
      privateKeySecretRef: {
        name: "letsencrypt-prod-account-key",
      },

      // Use HTTP-01 challenge (requires port 80 accessible)
      solvers: [
        {
          http01: {
            ingress: {
              ingressClassName: "traefik",
            },
          },
        },
      ],
    },
  },
}, {
  dependsOn: certManager,
  customTimeouts: {
    create: "10m", // Give cert-manager plenty of time to become ready
    update: "10m",
  },
});

// ClusterIssuer for Let's Encrypt Staging (optional, for testing)
// Use this first to test your setup without hitting rate limits
const letsencryptStaging = new k8s.apiextensions.CustomResource("letsencrypt-staging", {
  apiVersion: "cert-manager.io/v1",
  kind: "ClusterIssuer",
  metadata: {
    name: "letsencrypt-staging",
  },
  spec: {
    acme: {
      // Let's Encrypt staging server (for testing)
      server: "https://acme-staging-v02.api.letsencrypt.org/directory",

      email: "max_vissing@yahoo.de",

      privateKeySecretRef: {
        name: "letsencrypt-staging-account-key",
      },

      solvers: [
        {
          http01: {
            ingress: {
              ingressClassName: "traefik",
            },
          },
        },
      ],
    },
  },
}, {
  dependsOn: certManager,
  customTimeouts: {
    create: "10m", // Give cert-manager plenty of time to become ready
    update: "10m",
  },
});

export { certManager, letsencryptProd, letsencryptStaging };

// How it works:
//
// 1. When an Ingress is created with the annotation:
//    cert-manager.io/cluster-issuer: "letsencrypt-prod"
//
// 2. cert-manager sees it and:
//    - Creates a temporary HTTP endpoint on /.well-known/acme-challenge/
//    - Let's Encrypt validates you own the domain by checking this endpoint
//    - Issues a certificate
//    - Stores it as a Kubernetes Secret
//
// 3. Traefik reads the TLS secret and serves HTTPS automatically
//
// 4. cert-manager automatically renews certificates before they expire
//
// Usage in Ingress:
//   metadata:
//     annotations:
//       cert-manager.io/cluster-issuer: "letsencrypt-prod"
//   spec:
//     tls:
//       - secretName: my-app-tls
//         hosts:
//           - app.mvissing.de
//
// Testing:
// - Use "letsencrypt-staging" first to avoid rate limits
// - Staging certs are not trusted (browser warning)
// - Once working, switch to "letsencrypt-prod"
//
// Rate limits (Let's Encrypt production):
// - 50 certificates per domain per week
// - 5 duplicate certificates per week
// - Use staging for testing!
//
// Troubleshooting:
//   kubectl get certificate -A
//   kubectl get certificaterequest -A
//   kubectl describe certificate <name> -n <namespace>
//   kubectl logs -n cert-manager deployment/cert-manager
