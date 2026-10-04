// attic — self-hosted Nix-Binary-Cache für die Foreman-Builds.
//
// Der Flake (MaxMac99/Foreman, flake.nix) baut die Control-Plane- und
// Pod-Images; auf ephemeren GitHub-Runnern wäre jeder Build ein Cold-Build
// (~450 Crates). attic hält die Store-Pfade pro Plattform vor: CI pusht
// nach jedem Lauf, folgende Läufe ziehen nur Misses. Lokal (Mac,
// aarch64-darwin) teilt Max denselben Cache — `attic use foreman`.
//
// Monolithischer Modus (SQLite + Local Storage): beim ersten Start legt
// die OOBE `server.toml`, `server.db` und `storage/` unter $HOME an —
// $HOME liegt auf dem PVC, damit der RS256-Signing-Key Restarts überlebt.
// Ein PVC-Verlust = neuer Key = alle Clients müssen `attic use` erneut
// ausführen (bewusst akzeptiert, Homelab-Skala).
//
// Kein Public Edge — bewusst (D-014): die Foreman-CI läuft auf
// self-hosted ARC-Runnern im Cluster und erreicht attic über den
// ClusterIP-Service; der interne Ingress bedient den Mac (LAN/Tailscale).
// Auth macht attic selbst (signierte JWT-Tokens; der `foreman`-Cache
// bleibt privat, Pull+Push nur mit Token).
//
// Placement: Brink, amd64 — direkt neben der Control Plane.
// Image: ghcr.io/zhaofengli/attic publiziert keine Versions-Tags
// (rolling `latest`) — Renovate pinnt hier nicht, Updates passieren via
// `pulumi up` nach manuellem Image-Pull. Bewusst: ein Cache ist schnell
// wieder aufgebaut, dafür immer aktuell.

import * as k8s from "@pulumi/kubernetes";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import {
  ARCH_LABEL,
  brinkSite,
  onNode,
  BRINK_SERVER,
} from "../infrastructure/sites";
import { foremanNamespace } from "./foreman";

const atticHost = "cache.mvissing.de";

// Config, SQLite und der RS256-Signing-Key leben auf dem PVC (OOBE schreibt
// bei erstem Start unter $HOME; HOME wird auf den Mount gesetzt).
export const atticDataPVC = new k8s.core.v1.PersistentVolumeClaim(
  "attic-data",
  {
    metadata: {
      name: "attic-data",
      namespace: foremanNamespace.metadata.name,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: {
        requests: { storage: "10Gi" },
      },
    },
  },
);

export const atticDeployment = new k8s.apps.v1.Deployment(
  "attic",
  {
    metadata: {
      name: "attic",
      namespace: foremanNamespace.metadata.name,
    },
    spec: {
      replicas: 1,
      // SQLite + RWO-PVC: kein Rolling mit zwei atticd-Prozessoren.
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: "attic" } },
      template: {
        metadata: { labels: { app: "attic" } },
        spec: {
          nodeSelector: {
            [ARCH_LABEL]: "amd64",
            ...onNode(BRINK_SERVER),
          },
          containers: [
            {
              name: "atticd",
              image: "ghcr.io/zhaofengli/attic:latest",
              ports: [{ containerPort: 8080, name: "http" }],
              env: [
                {
                  // OOBE-Pfad: Config/DB/Storage landen auf dem PVC.
                  name: "HOME",
                  value: "/var/lib/attic",
                },
              ],
              volumeMounts: [{ name: "data", mountPath: "/var/lib/attic" }],
              livenessProbe: {
                httpGet: { path: "/", port: 8080 },
                initialDelaySeconds: 15,
                periodSeconds: 30,
                failureThreshold: 5,
              },
              resources: {
                requests: { cpu: "50m", memory: "128Mi" },
                limits: { cpu: "1000m", memory: "512Mi" },
              },
            },
          ],
          volumes: [
            {
              name: "data",
              persistentVolumeClaim: { claimName: atticDataPVC.metadata.name },
            },
          ],
        },
      },
    },
  },
  {
    dependsOn: [atticDataPVC],
  },
);

export const atticService = new k8s.core.v1.Service("attic", {
  metadata: {
    name: "attic",
    namespace: foremanNamespace.metadata.name,
  },
  spec: {
    type: "ClusterIP",
    selector: { app: "attic" },
    ports: [{ port: 8080, targetPort: 8080, name: "http" }],
  },
});

// Interner Edge (LAN/Tailscale — Mac-Pulls laufen hier drüber). Dieser
// Ingress trägt die Issuer-Annotation: genau Einer besitzt die Ausstellung
// gegen das geteilte TLS-Secret (meals-Muster).
export const atticIngress = new k8s.networking.v1.Ingress("attic-ingress", {
  metadata: {
    name: "attic",
    namespace: foremanNamespace.metadata.name,
    annotations: {
      "pulumi.com/skipAwait": "true",
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "traefik.ingress.kubernetes.io/redirect-entry-point": "websecure",
      "traefik.ingress.kubernetes.io/redirect-permanent": "true",
      "cert-manager.io/cluster-issuer": activeClusterIssuer,
    },
  },
  spec: {
    ingressClassName: "traefik",
    rules: [
      {
        host: atticHost,
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: {
                service: {
                  name: atticService.metadata.name,
                  port: { number: 8080 },
                },
              },
            },
          ],
        },
      },
    ],
    tls: [
      {
        secretName: "attic-tls",
        hosts: [atticHost],
      },
    ],
  },
});
