// T3 Code — dauerhaft laufender Agent-Host für die Entwicklung.
//
// Löst das MacBook als T3-Server ab: Threads laufen weiter, wenn der Laptop
// zu ist, gesteuert wird von Mac, Web (app.t3.codes) und iPhone. Das MacBook
// bleibt als zweite T3-Umgebung für Xcode-/iOS-Arbeit, die hier nicht geht.
//
// ⚠️ **Haustier, kein Wegwerf-Pod — und das ist eine Entscheidung.** T3
// aktualisiert sich selbst (`t3 update`), und die Server-Version muss zur
// Mobile-App passen, die oft released. Ein gepinntes Image hinge ständig
// hinterher. Deshalb liegt alles, was T3 und die Agenten über die Zeit
// ansammeln, auf PVCs: $HOME (T3-Binary + Userdata, Provider-Logins,
// Repos/Worktrees) und /nix (Devshells der Projekte via direnv). Das Image
// ist nur die Debian-Basis; `bootstrap.sh` installiert beim ersten Start
// idempotent nach, was fehlt. Ein PVC-Verlust = neu einloggen (T3 Connect,
// claude, codex, gh), Threads weg — Homelab-Skala, bewusst akzeptiert.
//
// Erreichbarkeit:
//   - **T3 Connect** (primär): ausgehender Cloudflare-Tunnel, funktioniert
//     von überall und ist der einzige Weg zu Push-Benachrichtigungen
//     (docs/user/mobile-notifications.md). Einmalig per `kubectl exec`
//     einrichten, siehe unten.
//   - **Interner Ingress** `t3.mvissing.de` (LAN/Mesh, Fallback): echtes
//     HTTPS über cert-manager, das Headscale (keine ts.net-Zertifikate)
//     nicht liefern kann. Auth macht T3 selbst (Pairing-Token = Passwort).
//     Bewusst NICHT auf traefik-public.
//
// Isolation: kein ServiceAccount-Token, kein Host-Zugriff. Ein Agent mit
// Vollzugriff kann den Pod beschädigen, nicht den Cluster. sudo im
// Container bleibt (apt für Chromium-Libs bei jedem Start).
//
// Placement: maxdata (NVMe unter /fast), weg von brink-server, das als
// einziger Dauerläufer der Wohnung DNS, Subnet-Router und etcd trägt.
//
// Einmalige Einrichtung nach dem ersten `pulumi up` (Pod ist Ready):
//   kubectl -n t3code exec -it deploy/t3code -- bash -l
//     t3 connect            # Device-Code im Browser bestätigen, Service ablehnen
//     claude auth login
//     codex login
//     gh auth login && gh auth setup-git
//     git config --global user.name/user.email …
//   kubectl -n t3code rollout restart deploy/t3code   # Connect-Link aktivieren
// Danach `t3 update` im Pod + `rollout restart`, um die Version zu wechseln.

import { createHash } from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import { ARCH_LABEL, onNode, MAXDATA } from "../infrastructure/sites";

const t3Host = "t3.mvissing.de";
const t3Port = 3773;

// devcontainers/base bringt den Nutzer `vscode` (uid 1000) mit
// passwortlosem sudo, git, curl und xz mit — alles, was die Installer
// brauchen. HOME liegt auf dem PVC.
const user = "vscode";
const home = `/home/${user}`;

export const t3Namespace = new k8s.core.v1.Namespace("t3code", {
  metadata: { name: "t3code" },
});

// Repos, Worktrees und Rust-target-Verzeichnisse mehrerer Projekte.
export const t3HomePVC = new k8s.core.v1.PersistentVolumeClaim("t3code-home", {
  metadata: { name: "t3code-home", namespace: t3Namespace.metadata.name },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "local-path",
    resources: { requests: { storage: "100Gi" } },
  },
});

// Nix-Store für die Devshells; ohne PVC lädt jeder Restart alles neu.
export const t3NixPVC = new k8s.core.v1.PersistentVolumeClaim("t3code-nix", {
  metadata: { name: "t3code-nix", namespace: t3Namespace.metadata.name },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "local-path",
    resources: { requests: { storage: "100Gi" } },
  },
});

// Idempotent: jeder Schritt prüft, ob er schon erledigt ist. Der erste
// Start dauert mehrere Minuten (Nix + Installer), spätere nur den
// apt-Lauf für Chromium.
const bootstrap = `#!/usr/bin/env bash
set -euo pipefail

# local-path legt Verzeichnisse root-owned an; fsGroup greift dort nicht.
sudo chown ${user}:${user} ${home} /nix

export PATH="${home}/.local/bin:${home}/.npm-global/bin:${home}/.nix-profile/bin:$PATH"

if [ ! -e ${home}/.nix-profile ]; then
  curl -fsSL https://nixos.org/nix/install | sh -s -- --no-daemon
  mkdir -p ${home}/.config/nix
  echo "experimental-features = nix-command flakes" > ${home}/.config/nix/nix.conf
fi
. ${home}/.nix-profile/etc/profile.d/nix.sh

for entry in node:nodejs_24 gh:gh direnv:direnv rg:ripgrep jq:jq; do
  command -v "\${entry%%:*}" >/dev/null || nix profile install "nixpkgs#\${entry#*:}"
done
[ -e ${home}/.nix-profile/share/nix-direnv ] || nix profile install nixpkgs#nix-direnv

if [ ! -f ${home}/.config/direnv/direnvrc ]; then
  mkdir -p ${home}/.config/direnv
  echo 'source $HOME/.nix-profile/share/nix-direnv/direnvrc' > ${home}/.config/direnv/direnvrc
fi
grep -q 'direnv hook bash' ${home}/.bashrc 2>/dev/null || {
  echo '. $HOME/.nix-profile/etc/profile.d/nix.sh' >> ${home}/.bashrc
  echo 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"' >> ${home}/.bashrc
  echo 'eval "$(direnv hook bash)"' >> ${home}/.bashrc
}

# Provider-CLIs nur beim ersten Mal; danach aktualisiert T3 sie selbst
# (Settings → Providers → Update now).
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash
if ! command -v codex >/dev/null; then
  npm config set prefix ${home}/.npm-global
  npm install -g @openai/codex
fi

command -v t3 >/dev/null || curl -fsSL https://t3.codes/install.sh | sh

# Rootfs ist flüchtig: Chromium-Libs und Fonts bei jedem Start.
sudo env "PATH=$PATH" t3 browser setup

exec t3 serve
`;

const t3Bootstrap = new k8s.core.v1.ConfigMap("t3code-bootstrap", {
  metadata: { name: "t3code-bootstrap", namespace: t3Namespace.metadata.name },
  data: { "bootstrap.sh": bootstrap },
});

export const t3Deployment = new k8s.apps.v1.Deployment(
  "t3code",
  {
    metadata: { name: "t3code", namespace: t3Namespace.metadata.name },
    spec: {
      // SQLite + RWO-PVCs: nie zwei Server auf denselben Daten.
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: "t3code" } },
      template: {
        metadata: {
          labels: { app: "t3code" },
          annotations: {
            // Bootstrap-Änderungen rollen den Pod.
            "t3code/bootstrap-hash": createHash("sha256")
              .update(bootstrap)
              .digest("hex"),
          },
        },
        spec: {
          automountServiceAccountToken: false,
          nodeSelector: {
            [ARCH_LABEL]: "amd64",
            ...onNode(MAXDATA),
          },
          containers: [
            {
              name: "t3code",
              image: "mcr.microsoft.com/devcontainers/base:2.2.3-trixie",
              command: ["/bin/bash", "/bootstrap/bootstrap.sh"],
              ports: [{ containerPort: t3Port, name: "http" }],
              securityContext: { runAsUser: 1000, runAsGroup: 1000 },
              env: [
                { name: "HOME", value: home },
                { name: "USER", value: user },
                { name: "T3CODE_HOST", value: "0.0.0.0" },
                { name: "T3CODE_PORT", value: String(t3Port) },
              ],
              volumeMounts: [
                { name: "home", mountPath: home },
                { name: "nix", mountPath: "/nix" },
                { name: "bootstrap", mountPath: "/bootstrap" },
              ],
              // Erster Start: Nix, Provider-CLIs und T3 installieren sich
              // erst — bis zu 15 Minuten Geduld, danach normale Probes.
              startupProbe: {
                tcpSocket: { port: t3Port },
                periodSeconds: 10,
                failureThreshold: 90,
              },
              livenessProbe: {
                tcpSocket: { port: t3Port },
                periodSeconds: 30,
                failureThreshold: 5,
              },
              // maxdata: 12 Kerne, ~10 GiB real frei neben k3s und 8 GiB
              // ZFS-ARC. Das Limit schützt die Nachbarn vor Cargo-Builds.
              resources: {
                requests: { cpu: "1000m", memory: "4Gi" },
                limits: { cpu: "8000m", memory: "10Gi" },
              },
            },
          ],
          volumes: [
            {
              name: "home",
              persistentVolumeClaim: { claimName: t3HomePVC.metadata.name },
            },
            {
              name: "nix",
              persistentVolumeClaim: { claimName: t3NixPVC.metadata.name },
            },
            {
              name: "bootstrap",
              configMap: { name: t3Bootstrap.metadata.name },
            },
          ],
        },
      },
    },
  },
  { dependsOn: [t3HomePVC, t3NixPVC, t3Bootstrap] },
);

export const t3Service = new k8s.core.v1.Service("t3code", {
  metadata: { name: "t3code", namespace: t3Namespace.metadata.name },
  spec: {
    type: "ClusterIP",
    selector: { app: "t3code" },
    ports: [{ port: t3Port, targetPort: t3Port, name: "http" }],
  },
});

// Interner Edge (LAN/Mesh) — WebSockets reicht Traefik ohne Extra-Config
// durch.
export const t3Ingress = new k8s.networking.v1.Ingress("t3code-ingress", {
  metadata: {
    name: "t3code",
    namespace: t3Namespace.metadata.name,
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
        host: t3Host,
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: {
                service: {
                  name: t3Service.metadata.name,
                  port: { number: t3Port },
                },
              },
            },
          ],
        },
      },
    ],
    tls: [{ secretName: "t3code-tls", hosts: [t3Host] }],
  },
});
