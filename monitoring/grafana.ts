// Grafana - Visualization and dashboards
// Integrates with Prometheus, Loki, and Tempo
// Uses Authentik for OAuth authentication
// Accessible via grafana.mvissing.de

import * as k8s from "@pulumi/kubernetes";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { onNode, MAXDATA } from "../infrastructure/sites";
import { namespaceName } from "./namespace";
import { prometheusUrl } from "./prometheus";
import { lokiUrl } from "./loki";
import { tempoQueryUrl } from "./tempo";
import {
  ntfyAlertTopic,
  ntfyAlertUsername,
  GRAFANA_NTFY_SECRET_NAME,
} from "./ntfy";
import {
  grafanaDatabaseHost,
  grafanaDatabaseName,
  grafanaDatabaseUser,
  grafanaDatabaseSecretName,
} from "./grafana-database";

// PersistentVolumeClaim for Grafana plugin storage
const grafanaPVC = new k8s.core.v1.PersistentVolumeClaim("grafana-pvc", {
  metadata: {
    name: "grafana",
    namespace: namespaceName,
  },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "local-path",
    resources: {
      requests: {
        storage: "10Gi",
      },
    },
  },
});

// Get Pulumi config for Authentik OAuth credentials
const config = new pulumi.Config();
const authentikClientId = config.requireSecret("grafana-oauth-client-id");
const authentikClientSecret = config.requireSecret(
  "grafana-oauth-client-secret",
);
const authentikUrl = "https://auth.mvissing.de";

// Generate random password for Grafana admin user
const grafanaAdminPassword = new random.RandomPassword(
  "grafana-admin-password",
  {
    length: 16,
    special: false,
  },
);

// Install Grafana using Helm chart

/**
 * Datasource uid the alert rules below query. See the note at the datasource.
 */
const PROMETHEUS_DS_UID = "prometheus";

/**
 * Build one Grafana alert rule from a PromQL expression.
 *
 * Grafana rules are not Prometheus rules: instead of a single `expr` that is
 * truthy when firing, a rule is a *pipeline* of queries. This wraps the common
 * two-stage shape — run the PromQL instantly (refId A), then threshold it
 * server-side (refId B) — so the ported rules below read like the originals.
 *
 * ⚠️ `> 0` on stage B is doing real work. The PromQL expressions here already
 * encode their own comparison (`... < 21`, `== 0`), so Prometheus returns a
 * series only when the condition holds; the threshold then just asks "did
 * anything come back". Writing the comparison in *both* places would invert
 * some of these.
 */
/**
 * Protect Grafana's own `{{ ... }}` from Helm.
 *
 * ⚠️ Not cosmetic. The Grafana chart pipes the whole `alerting` tree through
 * Helm's `tpl`, so any `{{ $labels.namespace }}` written literally is evaluated
 * as a *Helm* template and the render dies with
 * `undefined variable "$labels"` — the chart never installs at all.
 *
 * Wrapping each expression in backticks makes `tpl` emit it verbatim, so
 * Grafana receives the annotation it expects. Callers write the natural Grafana
 * syntax and this handles the escaping.
 */
const escapeHelm = (s: string) =>
  s.replace(/\{\{[\s\S]*?\}\}/g, (m) => "{{ `" + m + "` }}");

const promAlert = (r: {
  uid: string;
  title: string;
  expr: string;
  for: string;
  severity: "critical" | "warning";
  summary: string;
  description: string;
  /**
   * ⚠️ What "no series at all" means, which differs per rule and is not a
   * detail. For a ported rule it means the thing is simply not deployed, so
   * `OK` preserves the Prometheus behaviour. For the backup rule, absence of
   * the series *is* the failure — see its own note.
   */
  noDataState?: "OK" | "Alerting" | "NoData";
}) => ({
  uid: r.uid,
  title: r.title,
  condition: "B",
  for: r.for,
  labels: { severity: r.severity },
  annotations: {
    summary: escapeHelm(r.summary),
    description: escapeHelm(r.description),
  },
  noDataState: r.noDataState ?? "OK",
  // A rule that cannot be evaluated is not a healthy rule. Prometheus being
  // unreachable is itself worth a notification.
  execErrState: "Alerting",
  data: [
    {
      refId: "A",
      relativeTimeRange: { from: 600, to: 0 },
      datasourceUid: PROMETHEUS_DS_UID,
      model: { refId: "A", expr: r.expr, instant: true },
    },
    {
      refId: "B",
      datasourceUid: "__expr__",
      model: {
        refId: "B",
        type: "threshold",
        expression: "A",
        conditions: [{ evaluator: { type: "gt", params: [0] } }],
      },
    },
  ],
});

const grafana = new k8s.helm.v3.Chart("grafana", {
  chart: "grafana",
  version: "10.5.15",
  namespace: namespaceName,
  fetchOpts: {
    repo: "https://grafana.github.io/helm-charts",
  },
  transformations: [
    (obj: any, opts: any) => {
      if (obj.kind === "Role" || obj.kind === "ClusterRole") {
        opts.ignoreChanges = opts.ignoreChanges || [];
        opts.ignoreChanges.push("rules");
      }
    },
  ],
  values: {
    // Persistent storage for plugins only (dashboards/config now in PostgreSQL)
    // Use existingClaim so the Helm chart doesn't manage the PVC
    persistence: {
      enabled: true,
      existingClaim: "grafana",
    },

    // Disable init-chown-data container (not needed and causes permission issues)
    initChownData: {
      enabled: false,
    },

    // Pinned to maxdata: the `grafana` PVC below is local-path (D6).
    nodeSelector: onNode(MAXDATA),

    // Environment variables for database connection
    envFromSecret: grafanaDatabaseSecretName,

    // The ntfy publishing credential, referenced as `$NTFY_PASSWORD` by the
    // contact point below.
    //
    // ⚠️ By *name*, via a Secret built in `./ntfy`, rather than by value via
    // `envRenderSecret`. The chart renders client-side at preview time, so a
    // values tree containing an unknown cannot be rendered at all — Pulumi
    // reports `[Can't preview] all chart values must be known ahead of time`
    // and plans to **delete every resource in this chart**. Passing the
    // password by value did precisely that: rotating it previewed as deleting
    // Grafana's Deployment, Service, Ingress and RBAC. A name is constant, so
    // the chart always renders.
    //
    // ⚠️ `env` is not an option either — the chart renders that into a plain
    // ConfigMap.
    envFromSecrets: [{ name: GRAFANA_NTFY_SECRET_NAME }],

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
      ingressClassName: "traefik", // Changed from traefik-external - now using port forwarding on ionos
      annotations: {
        "cert-manager.io/cluster-issuer": activeClusterIssuer,
        // Homepage dashboard discovery
        "gethomepage.dev/enabled": "true",
        "gethomepage.dev/name": "Grafana",
        "gethomepage.dev/description": "Dashboards & Visualization",
        "gethomepage.dev/group": "Monitoring",
        "gethomepage.dev/icon": "grafana",
        "gethomepage.dev/href": "https://grafana.mvissing.de",
        // Grafana widget - shows dashboard and alert stats
        "gethomepage.dev/widget.type": "grafana",
        "gethomepage.dev/widget.url":
          "http://grafana.monitoring.svc.cluster.local",
        "gethomepage.dev/widget.username": "admin",
        "gethomepage.dev/widget.password":
          '{{ "{{HOMEPAGE_VAR_GRAFANA_PASSWORD}}" }}',
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
        role_attribute_path:
          "contains(groups, 'Grafana Admins') && 'Admin' || contains(groups, 'Grafana Editors') && 'Editor' || 'Viewer'",
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
            // ⚠️ Pinned. Alert rules reference a datasource by *uid*, and an
            // unpinned one gets a hash Grafana derives from the name — stable
            // in practice, but not a contract, and a rename would silently
            // detach every rule below. Checked before pinning: the previous
            // value (PBFA97CFB590B2093) appears in none of the five
            // dashboards, so adopting a readable uid breaks nothing.
            uid: PROMETHEUS_DS_UID,
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

    // ---------------------------------------------------------------------
    // Unified alerting. See docs/immich-migration.md Phase C.
    //
    // Grafana had **no provisioned alerting at all** before this — no contact
    // points, no notification policies, no rules. The estate's alerting lived
    // entirely in Prometheus + Alertmanager.
    //
    // ⚠️ During the port the rules exist in *both* places, so a firing alert
    // notifies twice on the same ntfy topic. That is deliberate: the plan is
    // port -> verify each fires -> remove from Prometheus, and removing first
    // would mean a window with no alerting at all. Phase C3 deletes the
    // Prometheus copies.
    // ---------------------------------------------------------------------
    alerting: {
      "contactpoints.yaml": {
        apiVersion: 1,
        contactPoints: [
          {
            orgId: 1,
            name: "ntfy",
            receivers: [
              {
                uid: "ntfy-webhook",
                type: "webhook",
                settings: {
                  // ⚠️ `?template=grafana` is a **built-in ntfy template**, not
                  // something defined here — verified by posting a Grafana-
                  // shaped payload to the running v2.27.0 and getting back
                  // `🚨 [FIRING:1] ... `. It is a *different* template from the
                  // `alertmanager` one `prometheus.ts` uses, and the two are
                  // not interchangeable: the payload shapes differ, and feeding
                  // Grafana's JSON to the alertmanager template fails outright.
                  //
                  // Without it ntfy publishes Grafana's raw JSON as the message
                  // body, which arrives as an unreadable wall of text.
                  url: pulumi.interpolate`http://ntfy.${namespaceName}.svc.cluster.local/${ntfyAlertTopic}?template=grafana`,
                  httpMethod: "POST",
                  username: ntfyAlertUsername,
                  // ⚠️ `$NTFY_PASSWORD`, not `$__env{NTFY_PASSWORD}`. The two
                  // syntaxes are not the same: `$__env{}` is grafana.ini's,
                  // while *provisioning* files take a bare `$VAR`. Getting it
                  // wrong sends the literal string as the password and fails
                  // with 401 at delivery time only.
                  //
                  // Supplied by envRenderSecret above, so it lands in a Secret
                  // rather than the chart's ConfigMap.
                  password: "$NTFY_PASSWORD",
                },
                disableResolveMessage: false,
              },
            ],
          },
        ],
      },

      "policies.yaml": {
        apiVersion: 1,
        policies: [
          {
            orgId: 1,
            receiver: "ntfy",
            group_by: ["alertname", "grafana_folder"],
            group_wait: "30s",
            group_interval: "5m",
            // 12 h, matching Alertmanager's existing setting and for the same
            // reason: these alerts are slow-moving, and re-notifying every few
            // hours trains you to ignore the notification.
            repeat_interval: "12h",
          },
        ],
      },

      "rules.yaml": {
        apiVersion: 1,
        groups: [
          {
            orgId: 1,
            name: "certificates",
            folder: "Alerts",
            interval: "1m",
            rules: [
              promAlert({
                uid: "cert-expiring-soon",
                title: "CertificateExpiringSoon",
                expr: "(certmanager_certificate_expiration_timestamp_seconds - time()) / 86400 < 21",
                for: "1h",
                severity: "critical",
                summary:
                  "Certificate {{ $labels.namespace }}/{{ $labels.name }} expires in {{ $values.A }} days",
                description:
                  "Renewal should have happened at 30 days and has not. Check the public ingress path on ionos: nginx on :80 and the traefik-public pod must be reachable from the internet for HTTP-01 to validate.",
              }),
              promAlert({
                uid: "cert-not-ready",
                title: "CertificateNotReady",
                expr: 'certmanager_certificate_ready_status{condition="False"} == 1',
                for: "1h",
                severity: "warning",
                summary:
                  "Certificate {{ $labels.namespace }}/{{ $labels.name }} has not been ready for an hour",
                description:
                  "Check `kubectl describe certificate` and any Order/Challenge in that namespace.",
              }),
            ],
          },
          {
            orgId: 1,
            name: "public-ingress",
            folder: "Alerts",
            interval: "1m",
            rules: [
              promAlert({
                uid: "public-ingress-down",
                title: "PublicIngressDown",
                expr: 'kube_deployment_status_replicas_available{deployment="traefik-public"} == 0',
                for: "15m",
                severity: "critical",
                summary: "The public Traefik on ionos has no available replica",
                description:
                  "ACME HTTP-01 challenges cannot be served. Certificates will not renew, and nothing else will report this until they start expiring in ~30 days.",
              }),
            ],
          },
          {
            orgId: 1,
            name: "zfs",
            folder: "Alerts",
            interval: "1m",
            rules: [
              promAlert({
                uid: "zfs-pool-not-online",
                title: "ZfsPoolNotOnline",
                expr: 'zpool_state{state="online"} == 0',
                for: "5m",
                severity: "critical",
                summary:
                  "ZFS pool {{ $labels.pool }} on {{ $labels.host }} is not ONLINE",
                description:
                  "Run `zpool status {{ $labels.pool }}` on {{ $labels.host }} to see which vdev is affected.",
              }),
              promAlert({
                uid: "zfs-vdev-errors",
                title: "ZfsVdevErrors",
                expr: "increase(vdev_read_errors_total[1h]) > 0 or increase(vdev_write_errors_total[1h]) > 0 or increase(vdev_checksum_errors_total[1h]) > 0",
                // 10 m rather than firing immediately: a single exporter
                // restart can make PromQL's counter-reset handling read as a
                // spurious `increase` on an otherwise-idle vdev.
                for: "10m",
                severity: "warning",
                summary:
                  "ZFS vdev {{ $labels.vdev }} in pool {{ $labels.pool }} on {{ $labels.host }} logged new read/write/checksum errors",
                description:
                  "The pool may still read ONLINE if redundancy absorbed it so far. Run `zpool status -v {{ $labels.pool }}` on {{ $labels.host }} before it does not.",
              }),
            ],
          },
          {
            orgId: 1,
            name: "backups",
            folder: "Alerts",
            interval: "5m",
            rules: [
              // Phase C4, and the alert this whole exercise exists for.
              //
              // Nothing watched the databases before. `postgres-1` sat broken
              // for three days — never replaying a transaction, retrying every
              // 5 s — while CNPG reported `2/2 ready, healthy` and no alert
              // existed that could have noticed.
              //
              // The series comes from databases/backup.ts, pushed to the
              // Pushgateway by a container that only runs if the dump actually
              // succeeded.
              promAlert({
                uid: "postgres-backup-stale",
                title: "PostgresBackupStale",
                expr: "(time() - postgres_backup_last_success_timestamp_seconds) / 3600 > 36",
                for: "10m",
                severity: "critical",
                // ⚠️ `Alerting`, unlike every rule above. For those, no series
                // means the thing is not deployed. Here it means no backup has
                // ever succeeded — or the Pushgateway lost its state — and a
                // missing backup must never be indistinguishable from a healthy
                // one. This is the same class of silence the broken replica hid
                // behind.
                noDataState: "Alerting",
                summary:
                  "No successful pg_dump of {{ $labels.database }} for over 36 hours",
                description:
                  "The nightly CronJob runs at 02:30 Europe/Berlin, so 36 h means at least one run was missed or failed. Check `kubectl get job -n database` and the dump container's log. Dumps land in /tank/k8s/nfs/pg-backups on maxdata.",
              }),
            ],
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
        // Cross-site ICMP probes (monitoring/blackbox.ts, Phase 12)
        "blackbox-exporter": {
          gnetId: 7587, // Prometheus Blackbox Exporter Overview
          revision: 3,
          datasource: "Prometheus",
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
