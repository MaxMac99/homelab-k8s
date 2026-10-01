// Foreman — die Control Plane für autonome Feature-Entwicklung (foreman-platform).
//
// Ein axum-Prozess (D-040: modularer Monolith) mit Workflow-Engine (D-005),
// Model Gateway (D-021), Gate-Kern mit ntfy-Push (AP-08) und Knowledge-Service
// (AP-21). Agenten laufen in **on-demand Workspace-Pods** im Namespace
// `foreman-proj-<slug>` (D-010/D-036): ein Pod pro Phasen-Versuch, gestorben wird
// am Gate, Recovery = frischer Clone. Playbook-Definitionen liegen im
// separaten Repo `MaxMac99/dev-playbooks` (D-006) und werden per Init-Container
// in ein Empty-Dir geklont; der Pilot ist `MaxMac99/mdcat-lite`.
//
// ⚠️ **Kein public edge — und das ist eine Entscheidung, kein Gap.** Die API
// ist das Bearer-geschützte Eingangstor (D-024); ntfy-Action-Buttons und die
// spätere macOS-App erreichen sie über Tailscale/LAN (Split-Horizon-DNS,
// traefik ingressClass, `foreman.mvissing.de`). Der interne Edge lädt
// Max' Gates, nichts liegt am Internet.
//
// Placement: pinned to **Brink** (meals-Muster), DB auf `postgres-brink`
// (databases/postgresql.ts) — die State-Machine hängt an Postgres, alles an
// einem Ort. amd64 only: winkel-pi ist der einzige arm64-Knoten.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import {
  ARCH_LABEL,
  brinkSite,
  onNode,
  BRINK_SERVER,
} from "../infrastructure/sites";
import {
  foremanDbPassword,
  postgresqlClusterName,
  postgresqlHost,
  postgresqlNamespace,
} from "../databases/postgresql";

const config = new pulumi.Config("k8s-resources");
const registryPullToken = config.requireSecret("foremanRegistryPullToken");

// Die Secrets der Control Plane (D-012): echte Provider-Credentials (nur
// OPENROUTER_API_KEY, im Gateway), API-Token, Gateway-Signing-Key und die
// GitHub-App-Credentials (ephemere Installations-Tokens für die Pods erzeugt
// der Credential-Helper-Pfad, AP-07). Werte liegen verschlüsselt in
// Pulumi.default.yaml — gesetzt werden sie per
//   pulumi config set --secret k8s-resources:<key> <value>
const apiToken = config.requireSecret("foremanApiToken");
const gatewaySigningKey = config.requireSecret("foremanGatewaySigningKey");
const openrouterApiKey = config.requireSecret("foremanOpenRouterApiKey");
const githubAppId = config.require("foremanGithubAppId");
const githubInstallationId = config.require("foremanGithubInstallationId");
const githubPrivateKey = config.requireSecret("foremanGithubPrivateKey");
const ntfyToken = pulumi.output(config.getSecret("foremanNtfyToken") || "");

// Lese-Token für den Init-Clone von dev-playbooks (PAT mit repo:read auf
// das private Playbook-Repo; die Workspace-Pods bekommen stattdessen
// ephemere App-Tokens, nie dieses).
const playbooksGitToken = config.requireSecret("foremanGitToken");

export const foremanNamespace = new k8s.core.v1.Namespace("foreman", {
  metadata: { name: "foreman" },
});

// Der Pilot läuft im Projekt-Namespace `foreman-proj-<slug>` (D-010/D-036,
// Namensschema des Pod-Runners: Namespace pro Projekt).
export const foremanAgentsNamespace = new k8s.core.v1.Namespace(
  "foreman-proj-mdcat-lite",
  {
    metadata: { name: "foreman-proj-mdcat-lite" },
  },
);

// Least privilege für die Control Plane: Workspace-Pods, Verify-Jobs und
// State-PVCs im Projekt-Namespace — sonst nichts (D-011/D-012).
export const foremanControlSA = new k8s.core.v1.ServiceAccount(
  "foreman-control",
  {
    metadata: {
      name: "foreman-control",
      namespace: foremanNamespace.metadata.name,
    },
  },
);

// Der globale Agent-Pod-Cap (D-036) zählt cluster-weit (Api::all), weil die
// Engine die Projekt-Namespaces nicht kennt — daher list/watch auf pods für
// genau diesen SA, sonst nichts.
export const foremanCapClusterRole = new k8s.rbac.v1.ClusterRole(
  "foreman-cap-probe",
  {
    metadata: { name: "foreman-cap-probe" },
    rules: [
      {
        apiGroups: [""],
        resources: ["pods"],
        verbs: ["list", "watch"],
      },
    ],
  },
);

new k8s.rbac.v1.ClusterRoleBinding("foreman-cap-probe", {
  metadata: { name: "foreman-cap-probe" },
  roleRef: {
    apiGroup: "rbac.authorization.k8s.io",
    kind: "ClusterRole",
    name: "foreman-cap-probe",
  },
  subjects: [
    {
      kind: "ServiceAccount",
      name: "foreman-control",
      namespace: foremanNamespace.metadata.name,
    },
  ],
});

export const foremanAgentsRole = new k8s.rbac.v1.Role("foreman-control", {
  metadata: {
    name: "foreman-control",
    namespace: foremanAgentsNamespace.metadata.name,
  },
  rules: [
    {
      apiGroups: [""],
      resources: ["pods", "persistentvolumeclaims"],
      verbs: ["create", "get", "list", "watch", "delete"],
    },
    {
      apiGroups: ["batch"],
      resources: ["jobs"],
      verbs: ["create", "get", "list", "watch", "delete"],
    },
  ],
});

new k8s.rbac.v1.RoleBinding("foreman-control", {
  metadata: {
    name: "foreman-control",
    namespace: foremanAgentsNamespace.metadata.name,
  },
  roleRef: {
    apiGroup: "rbac.authorization.k8s.io",
    kind: "Role",
    name: "foreman-control",
  },
  subjects: [
    {
      kind: "ServiceAccount",
      name: "foreman-control",
      namespace: foremanNamespace.metadata.name,
    },
  ],
});

// Pull secret für die privaten GHCR-Packages (foreman-server, foreman-pod).
// imagePullSecrets lösen nur im Pod-Namespace auf → der gleiche Secret muss
// auch im Projekt-Namespace der Workspace-Pods liegen.
new k8s.core.v1.Secret("foreman-registry-pull", {
  metadata: {
    name: "foreman-registry-pull",
    namespace: foremanNamespace.metadata.name,
  },
  type: "kubernetes.io/dockerconfigjson",
  stringData: {
    ".dockerconfigjson": registryPullToken.apply((token) =>
      Buffer.from(
        JSON.stringify({
          auths: {
            "ghcr.io": {
              username: "MaxMac99",
              password: token,
              auth: Buffer.from(`MaxMac99:${token}`).toString("base64"),
            },
          },
        }),
      ).toString("utf8"),
    ),
  },
});

new k8s.core.v1.Secret("foreman-registry-pull-agents", {
  metadata: {
    name: "foreman-registry-pull",
    namespace: foremanAgentsNamespace.metadata.name,
  },
  type: "kubernetes.io/dockerconfigjson",
  stringData: {
    ".dockerconfigjson": registryPullToken.apply((token) =>
      Buffer.from(
        JSON.stringify({
          auths: {
            "ghcr.io": {
              username: "MaxMac99",
              password: token,
              auth: Buffer.from(`MaxMac99:${token}`).toString("base64"),
            },
          },
        }),
      ).toString("utf8"),
    ),
  },
});

// Datenbank auf dem geteilten Brink-Cluster — Database CR mit eigenem Owner
// (CNPG erzeugt die Rolle automatisch), Credential-Secret direkt im
// App-Namespace (belt-and-braces wie meals.ts, nicht auf Reflector verlassen).
export const foremanDatabase = new k8s.apiextensions.CustomResource(
  "foreman-database",
  {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Database",
    metadata: {
      name: "foreman-db",
      namespace: postgresqlNamespace,
    },
    spec: {
      name: "foreman",
      owner: "foreman",
      cluster: {
        name: postgresqlClusterName,
      },
      // ⚠️ Explicit, though it is also the default: removing the CR must not
      // DROP the workflow state (append-only `workflow_events`, A1).
      databaseReclaimPolicy: "retain",
    },
  },
);

const foremanDbSecret = new k8s.core.v1.Secret("foreman-db-secret", {
  metadata: {
    name: "postgres-foreman",
    namespace: foremanNamespace.metadata.name,
  },
  type: "kubernetes.io/basic-auth",
  stringData: {
    username: "foreman",
    password: foremanDbPassword,
  },
});

// Composed connection string as one secret key — the server takes
// DATABASE_URL verbatim and the password never lands in the pod spec.
const foremanConfig = new k8s.core.v1.Secret("foreman-config", {
  metadata: {
    name: "foreman-config",
    namespace: foremanNamespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    DATABASE_URL: pulumi.interpolate`postgresql://foreman:${foremanDbPassword}@${postgresqlHost}:5432/foreman`,
  },
});

// Credentials-Secrets: Gateway + API (Bearer-Auth), GitHub-App (Private-Key
// wird als Datei gemountet), ntfy optional (Publish-Token).
const foremanSecrets = new k8s.core.v1.Secret("foreman-secrets", {
  metadata: {
    name: "foreman-secrets",
    namespace: foremanNamespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    FOREMAN_API_TOKEN: apiToken.apply((v) => v as string),
    FOREMAN_GATEWAY_SIGNING_KEY: gatewaySigningKey.apply((v) => v as string),
    OPENROUTER_API_KEY: openrouterApiKey.apply((v) => v as string),
    FOREMAN_GITHUB_PRIVATE_KEY: githubPrivateKey.apply((v) => v as string),
    NTFY_TOKEN: ntfyToken.apply((v) => v as string),
  },
});

const foremanGithubSecret = new k8s.core.v1.Secret("foreman-github", {
  metadata: {
    name: "foreman-github",
    namespace: foremanNamespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    "private-key.pem": githubPrivateKey.apply((v) => v as string),
  },
});

// Playbooks-Lese-Token nur für den Init-Container (nicht im Hauptprozess).
const foremanPlaybooksSecret = new k8s.core.v1.Secret("foreman-playbooks-git", {
  metadata: {
    name: "foreman-playbooks-git",
    namespace: foremanNamespace.metadata.name,
  },
  type: "Opaque",
  stringData: {
    token: playbooksGitToken.apply((v) => v as string),
  },
});

// Gateway-Routing für die Live-Abnahme: OpenRouter-only (D-033-Fallback-Kette
// kommt später mit den Claude/Codex-CLI-Adaptern; jeder Modell-Wechsel landet
// als `model_switch` im workflow_events-Log).
// Gateway-Routing für die Live-Abnahme: OpenRouter-only (D-033-Fallback-Kette
// kommt später mit den Claude/Codex-CLI-Adaptern; jeder Modell-Wechsel landet
// als `model_switch` im workflow_events-Log). Modellwunsch Max: GLM-5.3-Flash
// (z-ai) für beide Klassen.
const GATEWAY_ROUTING = JSON.stringify({
  strong: [{ provider: "open-router", model: "z-ai/glm-5.3-flash" }],
  small: [{ provider: "open-router", model: "z-ai/glm-5.3-flash" }],
  budget: {},
});

export const foremanControlDeployment = new k8s.apps.v1.Deployment(
  "foreman-control",
  {
    metadata: {
      name: "foreman-control",
      namespace: foremanNamespace.metadata.name,
    },
    spec: {
      // State Machine + Outbox: genau eine Instanz (D-005); Migrationen
      // laufen beim Start (production_state -> run_migrations).
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: "foreman-control" } },
      template: {
        metadata: { labels: { app: "foreman-control" } },
        spec: {
          serviceAccountName: foremanControlSA.metadata.name,
          nodeSelector: {
            [ARCH_LABEL]: "amd64",
            ...onNode(BRINK_SERVER),
          },
          imagePullSecrets: [{ name: "foreman-registry-pull" }],
          volumes: [
            {
              name: "playbooks",
              emptyDir: {},
            },
            {
              name: "github-key",
              secret: { secretName: foremanGithubSecret.metadata.name },
            },
          ],
          initContainers: [
            {
              name: "playbooks",
              // dev-playbooks checkout (D-006): Definitionen sind Daten in
              // einem eigenen Repo; der Init-Container klont frisch pro
              // Pod-Start, damit Playbook-PRs beim nächsten Deploy greifen.
              image: "docker.io/library/alpine:3.20",
              command: ["/bin/sh", "-ec"],
              args: [
                `apk add --no-cache git >/dev/null && \
                 AUTH=$(printf 'x-access-token:%s' "$FOREMAN_GIT_TOKEN" | base64 | tr -d '\\n') && \
                 git -c http.extraHeader="Authorization: Basic $AUTH" clone \\
                   https://github.com/MaxMac99/dev-playbooks.git /playbooks`,
              ],
              env: [
                {
                  name: "FOREMAN_GIT_TOKEN",
                  valueFrom: {
                    secretKeyRef: {
                      name: foremanPlaybooksSecret.metadata.name,
                      key: "token",
                    },
                  },
                },
              ],
              volumeMounts: [{ name: "playbooks", mountPath: "/playbooks" }],
            },
          ],
          containers: [
            {
              name: "control-plane",
              // Renovate-format one-liner; image built from deploy/server-image.
              image: "ghcr.io/maxmac99/foreman-server:0.1.9",
              ports: [{ containerPort: 8080, name: "http" }],
              envFrom: [
                { secretRef: { name: foremanConfig.metadata.name } },
                { secretRef: { name: foremanSecrets.metadata.name } },
              ],
              env: [
                {
                  name: "FOREMAN_BIND",
                  value: "0.0.0.0:8080",
                },
                {
                  name: "FOREMAN_PUBLIC_BASE_URL",
                  value: "https://foreman.mvissing.de",
                },
                {
                  name: "FOREMAN_PLAYBOOKS_DIR",
                  value: "/playbooks",
                },
                {
                  // Pilot (approval 2026-10-01): mdcat-lite.
                  name: "FOREMAN_PILOT_REPO_URL",
                  value: "https://github.com/MaxMac99/mdcat-lite.git",
                },
                {
                  name: "FOREMAN_PILOT_PROJECT_SLUG",
                  value: "mdcat-lite",
                },
                {
                  name: "FOREMAN_PILOT_NAMESPACE",
                  value: foremanAgentsNamespace.metadata.name,
                },
                {
                  name: "FOREMAN_PILOT_BASE_BRANCH",
                  value: "main",
                },
                {
                  // Globales Agent-Pod-Cap (D-036): schützt Abos/Nodes.
                  name: "FOREMAN_AGENT_POD_CAP",
                  value: "2",
                },
                {
                  name: "FOREMAN_POD_IMAGE",
                  value: "ghcr.io/maxmac99/foreman-pod:0.1.3",
                },
                {
                  name: "FOREMAN_IMAGE_PULL_SECRET",
                  value: "foreman-registry-pull",
                },
                {
                  // State-PVCs pin storage explicitly (estate philosophy).
                  name: "FOREMAN_STATE_STORAGE_CLASS",
                  value: "local-path",
                },
                {
                  // D-021: der Pod kennt nur das Gateway als Provider.
                  name: "FOREMAN_LLM_BASE_URL",
                  value: "http://foreman.foreman.svc.cluster.local:8080",
                },
                {
                  name: "FOREMAN_GATEWAY_ROUTING",
                  value: GATEWAY_ROUTING,
                },
                {
                  name: "FOREMAN_GITHUB_APP_ID",
                  value: githubAppId,
                },
                {
                  name: "FOREMAN_GITHUB_INSTALLATION_ID",
                  value: githubInstallationId,
                },
                {
                  name: "FOREMAN_GITHUB_PRIVATE_KEY_PATH",
                  value: "/secrets/github/private-key.pem",
                },
                {
                  name: "NTFY_URL",
                  value: "http://ntfy.monitoring.svc.cluster.local",
                },
                {
                  name: "NTFY_TOPIC",
                  value: "foreman",
                },
                {
                  name: "FOREMAN_GITHUB_HOST",
                  value: "github.com",
                },
              ],
              volumeMounts: [
                { name: "playbooks", mountPath: "/playbooks" },
                { name: "github-key", mountPath: "/secrets/github" },
              ],
              readinessProbe: {
                httpGet: { path: "/healthz", port: 8080 },
                initialDelaySeconds: 5,
                periodSeconds: 10,
                failureThreshold: 12,
              },
              livenessProbe: {
                httpGet: { path: "/healthz", port: 8080 },
                initialDelaySeconds: 30,
                periodSeconds: 30,
                failureThreshold: 5,
              },
              resources: {
                requests: { cpu: "100m", memory: "128Mi" },
                limits: { cpu: "1000m", memory: "512Mi" },
              },
            },
          ],
        },
      },
    },
  },
  {
    dependsOn: [
      foremanControlSA,
      foremanAgentsRole,
      foremanDatabase,
      foremanDbSecret,
      foremanConfig,
      foremanSecrets,
      foremanGithubSecret,
      foremanPlaybooksSecret,
    ],
  },
);

export const foremanService = new k8s.core.v1.Service("foreman", {
  metadata: {
    name: "foreman",
    namespace: foremanNamespace.metadata.name,
  },
  spec: {
    type: "ClusterIP",
    selector: { app: "foreman-control" },
    ports: [{ port: 80, targetPort: 8080, name: "http" }],
  },
});

// Interner Edge (traefik ingressClass, Split-Horizon-DNS): erreichbar aus
// beiden Homes und über Tailscale — bewusst NICHT auf traefik-public.
export const foremanIngress = new k8s.networking.v1.Ingress("foreman-ingress", {
  metadata: {
    name: "foreman",
    namespace: foremanNamespace.metadata.name,
    annotations: {
      "pulumi.com/skipAwait": "true",
      "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      "cert-manager.io/cluster-issuer": activeClusterIssuer,
      "traefik.ingress.kubernetes.io/redirect-entry-point": "websecure",
      "traefik.ingress.kubernetes.io/redirect-permanent": "true",
      "gethomepage.dev/enabled": "true",
      "gethomepage.dev/name": "Foreman",
      "gethomepage.dev/description": "Autonome Feature-Entwicklung",
      "gethomepage.dev/group": "Home",
      "gethomepage.dev/icon": "cog",
      "gethomepage.dev/pod-selector": "app=foreman-control",
      "gethomepage.dev/href": "https://foreman.mvissing.de",
    },
  },
  spec: {
    ingressClassName: "traefik",
    rules: [
      {
        host: "foreman.mvissing.de",
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: {
                service: {
                  name: foremanService.metadata.name,
                  port: { number: 80 },
                },
              },
            },
          ],
        },
      },
    ],
    tls: [
      {
        secretName: "foreman-tls",
        hosts: ["foreman.mvissing.de"],
      },
    ],
  },
});
