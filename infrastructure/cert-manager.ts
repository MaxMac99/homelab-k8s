// cert-manager - Automatic TLS certificate management
// Automatically provisions and renews Let's Encrypt certificates
// Works with Traefik ingress to provide HTTPS

import * as k8s from "@pulumi/kubernetes";
import { publicIngressClass } from "./sites";

// Create namespace for cert-manager
const namespace = new k8s.core.v1.Namespace("cert-manager", {
  metadata: {
    name: "cert-manager",
  },
});

// Install cert-manager via Helm
const certManager = new k8s.helm.v3.Chart("cert-manager", {
  chart: "cert-manager",
  version: "v1.21.1",
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
// Which ClusterIssuer every Certificate and Ingress in this repo uses.
//
// **Production since 2026-08-07**, and only because the path was proven first.
//
// This estate validates over HTTP-01 (D8 revised — DNS-01 and the IONOS webhook
// are dropped, and there will be no API token), so issuance depends on port 80
// at the address public DNS points to. Until Phase 9 that was Headscale, which
// answered :80 and :443 on ionos for every *.mvissing.de name and returned 403
// to every challenge. Staying on staging through that period was not caution
// for its own sake: a production attempt would have burned Let's Encrypt's
// failed-validation budget for every hostname at once, and that is the one
// limit you cannot refill by deleting resources.
//
// What changed: `hosts/nixos/ionos/public-ingress.nix` in the `setup` repo puts
// nginx on :80 and routes everything except headscale.mvissing.de to
// ./traefik-public.ts. Verified before flipping — `home.mvissing.de` issued from
// `(STAGING) Dastardly Durum YR1`, order valid in ~20s.
//
// ⚠️ Renewal now depends on that nginx and that Traefik pod staying reachable
// from the internet, not on a DNS record. Nothing user-facing breaks when they
// fail; certificates simply stop renewing and everything expires ~30 days
// later. Note Let's Encrypt validated over **IPv6** (2a02:2479:5c:a00::1), so
// the v6 listener is load-bearing, not a nicety.
export const activeClusterIssuer = "letsencrypt-prod";

const letsencryptProd = new k8s.apiextensions.CustomResource(
  "letsencrypt-prod",
  {
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

        // HTTP-01, which needs port 80 reachable from the internet.
        //
        // ⚠️ The class is the **public** Traefik on ionos, not the site-local
        // one. cert-manager creates a temporary Ingress per challenge; if a
        // site-local Traefik claimed it, the challenge would live on a LAN
        // address Let's Encrypt cannot reach, and validation would fail with
        // nothing visibly wrong at either end (D8).
        //
        // ⚠️ This also makes renewal depend on public :80 staying reachable,
        // rather than on a DNS record. Anything that breaks the ionos front end
        // breaks renewal about 30 days later, long after the change that caused
        // it — so treat a 502 from that nginx as urgent even though nothing
        // user-facing is down at the time.
        solvers: [
          {
            http01: {
              ingress: {
                ingressClassName: publicIngressClass,
              },
            },
          },
        ],
      },
    },
  },
  {
    dependsOn: certManager,
    customTimeouts: {
      create: "10m", // Give cert-manager plenty of time to become ready
      update: "10m",
    },
  },
);

// ClusterIssuer for Let's Encrypt Staging (optional, for testing)
// Use this first to test your setup without hitting rate limits
const letsencryptStaging = new k8s.apiextensions.CustomResource(
  "letsencrypt-staging",
  {
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
                ingressClassName: publicIngressClass,
              },
            },
          },
        ],
      },
    },
  },
  {
    dependsOn: certManager,
    customTimeouts: {
      create: "10m", // Give cert-manager plenty of time to become ready
      update: "10m",
    },
  },
);

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
