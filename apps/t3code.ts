// T3 Code — dauerhaft laufender Agent-Host für die Entwicklung.
//
// Löst das MacBook als T3-Server ab: Threads laufen weiter, wenn der Laptop
// zu ist, gesteuert wird von Mac, Web (app.t3.codes) und iPhone. Das MacBook
// bleibt als zweite T3-Umgebung für Xcode-/iOS-Arbeit, die hier nicht geht.
//
// ⚠️ **Haustier, kein Wegwerf-Pod — und das ist eine Entscheidung.** Alles,
// was T3 und die Agenten über die Zeit ansammeln, liegt auf PVCs: $HOME
// (T3-Binary + Userdata, Provider-Logins,
// Repos/Worktrees) und /nix (Devshells der Projekte via direnv). Das Image
// ist nur die Debian-Basis; `bootstrap.sh` installiert beim ersten Start
// idempotent nach, was fehlt. Ein PVC-Verlust = neu einloggen (T3 Connect,
// claude, codex, opencode, gh), Threads weg — Homelab-Skala, bewusst
// akzeptiert.
//
// opencode läuft mit derselben Config wie auf dem Mac: `bootstrap.sh` baut
// sie aus dem setup-Repo (`SETUP_REV`, modules/apps/opencode/core.nix) und
// verlinkt sie nach ~/.config/opencode. Claude kommt über Meridian im
// Sidecar (dein Max-Login aus `claude auth login`), Codex über opencodes
// eigenen ChatGPT-Login. Updates laufen ohne Handgriff: Renovate hebt
// `OPENCODE_VERSION` sofort und `SETUP_REV` nachts, mergt automatisch,
// deploy.yml macht `pulumi up`, der Pod startet neu.
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
//     t3 connect publish    # Push + Live Activities, sonst kommt nichts an
//     claude auth login
//     codex login --device-auth
//     opencode auth login openai --method chatgpt-headless
//     gh auth login && gh auth setup-git
//     git config --global user.name/user.email …
// Ein laufender Tunnel (`t3 connect status`) braucht keinen Neustart.
// Danach `t3 update` im Pod + `rollout restart`, um die Version zu wechseln.

import { createHash } from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import { ARCH_LABEL, onNode, MAXDATA } from "../infrastructure/sites";

const t3Host = "t3.mvissing.de";
const t3Port = 3773;

// ⚠️ Die Server-Version muss zur Desktop-/Mobile-App passen, sonst
// verweigert die neuere Seite die Verbindung (docs/user/updating.md). Der
// Update-Knopf in der App kann nur einen `t3 service` aktualisieren; ein per
// `exec t3 serve` gestarteter Server bekommt nur einen Copy-Befehl. Deshalb
// pinnt Renovate die Version (npm `t3`, eigene Automerge-Spur ohne
// Schedule), und `bootstrap.sh` gleicht beim Start per `t3 update` an.
const T3_VERSION = "0.1.3";

// OpenCode 2 kommt als npm `@opencode/cli` (`opencode-ai` ist noch 1.x).
// Gepinnt statt T3s Provider-Update, damit Pod und Config (setup-Repo)
// zusammenpassen; `bootstrap.sh` gleicht beim Start an. Renovate-Spur wie T3.
const OPENCODE_VERSION = "2.2.0";

// Commit des setup-Repos, aus dem `bootstrap.sh` die opencode-Config
// (Skills, Commands, Agents, AGENTS.md, Permissions) baut — dieselbe wie auf
// dem Mac (modules/apps/opencode/core.nix). Renovate hebt ihn nachts.
const SETUP_REV = "e932b8a65b1d4be94c7dfa63ac61d23e178c9683";

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
# \`kubectl exec … bash -l\` ist eine Login-Shell und liest nur .bash_profile;
# das PVC verdeckt die .profile aus dem Image.
[ -f ${home}/.bash_profile ] || echo '[ -f ~/.bashrc ] && . ~/.bashrc' > ${home}/.bash_profile

# Kein SSH-Key im Pod: gh und git laufen über HTTPS + gh-Credential-Helper.
gh config set git_protocol https

# Provider-CLIs nur beim ersten Mal; danach aktualisiert T3 sie selbst
# (Settings → Providers → Update now).
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash
npm config set prefix ${home}/.npm-global
command -v codex >/dev/null || npm install -g @openai/codex

# opencode dagegen bei jedem Start auf den Pin, auch abwärts.
[ "$(opencode --version 2>/dev/null)" = "opencode v$OPENCODE_VERSION" ] ||
  npm install -g "@opencode/cli@$OPENCODE_VERSION"

# Env nur für opencode, wie der Mac-Wrapper: container-weit würde claude den
# Dummy-Key statt des Max-Logins nehmen. ~/.local/bin liegt vor .npm-global.
mkdir -p ${home}/.local/bin
cat > ${home}/.local/bin/opencode <<'EOF'
#!/usr/bin/env bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_API_KEY=x
export OPENCODE_DISABLE_LSP_DOWNLOAD=1
exec "$HOME/.npm-global/bin/opencode" "$@"
EOF
chmod +x ${home}/.local/bin/opencode

# opencode-Config aus dem setup-Repo. Schlägt der Build fehl (Netz), bleibt
# der letzte Stand verlinkt, statt T3 am Start zu hindern. Einträge einzeln
# verlinken: opencode schreibt service.json, package.json und node_modules
# selbst ins Verzeichnis.
nix build "github:MaxMac99/setup/$SETUP_REV#opencode-config" \\
  --out-link ${home}/.local/state/opencode-config ||
  echo "bootstrap: opencode-config für $SETUP_REV nicht gebaut, behalte den letzten Stand" >&2
mkdir -p ${home}/.config/opencode
for entry in ${home}/.local/state/opencode-config/*; do
  [ -e "$entry" ] || continue
  target=${home}/.config/opencode/$(basename "$entry")
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    mv "$target" "$target.pre-setup"
  fi
  ln -sfn "$entry" "$target"
done

# Dieselben Skills, Subagents und AGENTS.md für Claude Code, damit T3s
# claude-Provider sie direkt nutzt. Einzeln verlinken: ~/.claude/skills hält
# auch die von claude.ai synchronisierten Skills. Aus setup entfernte Einträge
# hinterlassen tote Links, die räumt das find weg.
nix build "github:MaxMac99/setup/$SETUP_REV#claude-config" \\
  --out-link ${home}/.local/state/claude-config ||
  echo "bootstrap: claude-config für $SETUP_REV nicht gebaut, behalte den letzten Stand" >&2
mkdir -p ${home}/.claude/skills ${home}/.claude/agents
for entry in ${home}/.local/state/claude-config/CLAUDE.md \\
  ${home}/.local/state/claude-config/skills/* \\
  ${home}/.local/state/claude-config/agents/*; do
  [ -e "$entry" ] || continue
  target=${home}/.claude/\${entry#${home}/.local/state/claude-config/}
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    mv "$target" "$target.pre-setup"
  fi
  ln -sfn "$entry" "$target"
done
find ${home}/.claude/skills ${home}/.claude/agents -maxdepth 1 -xtype l \\
  -lname '${home}/.local/state/claude-config/*' -delete

# Meridian (Claude Max für opencode) läuft im Sidecar; der wartet auf diesen
# Marker, damit er nach einem Rev-Bump nicht den alten Build startet.
nix build "github:MaxMac99/setup/$SETUP_REV#meridian" \\
  --out-link ${home}/.local/state/meridian ||
  echo "bootstrap: meridian für $SETUP_REV nicht gebaut, behalte den letzten Stand" >&2
echo "$SETUP_REV" > ${home}/.local/state/meridian.rev

if ! command -v t3 >/dev/null; then
  curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION="$T3_VERSION" sh
elif [ "$(t3 --version)" != "t3 v$T3_VERSION" ]; then
  # --allow-downgrade, damit ein git revert des Renovate-Bumps zurückrollt.
  t3 update --yes --allow-downgrade "$T3_VERSION"
fi

# Rootfs ist flüchtig: Chromium-Libs und Fonts bei jedem Start.
sudo env "PATH=$PATH" t3 browser setup

# T3 bietet nur eingeschaltete Provider an; ein frisches PVC kennt opencode
# nicht. Nur ergänzen, nie überschreiben — T3 läuft hier noch nicht.
settings=${home}/.t3/userdata/settings.json
mkdir -p "$(dirname "$settings")"
[ -f "$settings" ] || echo '{}' > "$settings"
if ! jq -e '.providerInstances.opencode' "$settings" >/dev/null; then
  jq '.providerInstances.opencode = {driver: "opencode", enabled: true}' \\
    "$settings" > "$settings.tmp"
  mv "$settings.tmp" "$settings"
fi

exec t3 serve
`;

// Bewusst ohne festen Namen: Datenänderungen ersetzen eine ConfigMap, und
// ein fester Name kollidiert beim create-before-delete mit dem Live-Objekt.
const t3Bootstrap = new k8s.core.v1.ConfigMap("t3code-bootstrap", {
  metadata: { namespace: t3Namespace.metadata.name },
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
                { name: "T3_VERSION", value: T3_VERSION },
                { name: "OPENCODE_VERSION", value: OPENCODE_VERSION },
                { name: "SETUP_REV", value: SETUP_REV },
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
            {
              // Meridian: Claude Max als Anthropic-API für opencode, auf
              // 127.0.0.1:3456 im Pod (wie launchd auf dem Mac). Eigener
              // Container, damit ein Absturz nur ihn neu startet, nicht T3.
              // Build und claude-Login teilt er sich über die PVCs mit t3code.
              name: "meridian",
              image: "mcr.microsoft.com/devcontainers/base:2.2.3-trixie",
              command: ["/bin/bash", "-c"],
              args: [
                `set -euo pipefail
# Ohne gültige machine-id hat Meridian keine Boot-Identität und jeder
# Session-Request endet mit 500; das Image bringt keine mit.
[ -s /etc/machine-id ] ||
  sudo sh -c 'tr -d - < /proc/sys/kernel/random/uuid > /etc/machine-id'
until [ "$(cat ${home}/.local/state/meridian.rev 2>/dev/null)" = "$SETUP_REV" ]; do
  sleep 5
done
exec ${home}/.local/state/meridian/bin/meridian`,
              ],
              securityContext: { runAsUser: 1000, runAsGroup: 1000 },
              env: [
                { name: "HOME", value: home },
                { name: "USER", value: user },
                { name: "SETUP_REV", value: SETUP_REV },
                {
                  name: "PATH",
                  value: `${home}/.local/bin:${home}/.nix-profile/bin:/usr/local/bin:/usr/bin:/bin`,
                },
                {
                  name: "MERIDIAN_CLAUDE_PATH",
                  value: `${home}/.local/bin/claude`,
                },
                {
                  // Macht die Identität eindeutig (sonst nur aus der
                  // zufälligen machine-id und dem PID-Namespace).
                  name: "MERIDIAN_HOST_ID",
                  valueFrom: { fieldRef: { fieldPath: "metadata.uid" } },
                },
              ],
              volumeMounts: [
                { name: "home", mountPath: home },
                { name: "nix", mountPath: "/nix" },
              ],
              // Lauscht nur auf 127.0.0.1, also exec statt httpGet. /livez
              // statt /health: /health prüft den Login und würde bei
              // abgelaufenem Login in eine Restart-Schleife führen.
              startupProbe: {
                exec: {
                  command: ["curl", "-sf", "http://127.0.0.1:3456/livez"],
                },
                periodSeconds: 10,
                failureThreshold: 90,
              },
              livenessProbe: {
                exec: {
                  command: ["curl", "-sf", "http://127.0.0.1:3456/livez"],
                },
                periodSeconds: 30,
                failureThreshold: 5,
              },
              resources: {
                requests: { cpu: "50m", memory: "256Mi" },
                limits: { cpu: "2000m", memory: "3Gi" },
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
