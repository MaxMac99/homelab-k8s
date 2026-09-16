// Grafana - Visualization and dashboards
// Integrates with Prometheus, Loki, and Tempo
// Uses Authentik for OAuth authentication
// Accessible via grafana.mvissing.de

import * as k8s from "@pulumi/kubernetes";
import * as authentik from "@pulumi/authentik";
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
import {
  defaultAuthorizationFlow,
  defaultInvalidationFlow,
  oauth2ScopeMappings,
  signingKey,
} from "../auth/authentik-config";
import { adminsGroup } from "../auth/authentik-directory";

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

// ---------------------------------------------------------------------------
// Authentik OAuth — provider and application managed here since the
// config-as-code adoption. Credentials flow from the provider resource
// (clientSecret as a secret output); the stack-config copies
// (grafana-oauth-client-id/secret) were removed when this landed.
const grafanaOauth2Provider = new authentik.ProviderOauth2(
  "grafana-oauth2-provider",
  {
    name: "Grafana",
    clientId: "ZWYXO9Pm5cuRFZWe3tYT6qxX3wPS2CXdZW2yq3vv",
    authorizationFlow: defaultAuthorizationFlow.id,
    invalidationFlow: defaultInvalidationFlow.id,
    propertyMappings: oauth2ScopeMappings,
    signingKey,
    // ⚠️ Snake_case map keys — see apps/immich.ts.
    allowedRedirectUris: [
      {
        matching_mode: "strict",
        url: "https://grafana.mvissing.de/login/generic_oauth",
        redirect_uri_type: "authorization",
      },
    ],
    // Non-default validity — everything else is the provider default.
    accessTokenValidity: "minutes=5",
    refreshTokenThreshold: "hours=1",
  },
);

const grafanaApplication = new authentik.Application("grafana-application", {
  name: "Grafana",
  slug: "grafana",
  protocolProvider: grafanaOauth2Provider.providerOauth2Id.apply(Number),
});

// The authorization gate: admins only (the estate pattern).
new authentik.PolicyBinding("grafana-group-binding", {
  target: grafanaApplication.uuid,
  group: adminsGroup.id,
  order: 0,
});

const authentikClientId = grafanaOauth2Provider.clientId;
const authentikClientSecret = grafanaOauth2Provider.clientSecret;
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
 * Grafana's own credentials, as a Secret rather than chart values.
 *
 * ⚠️ Two independent reasons, and the second is the one that bites:
 *
 * 1. The chart renders `env` into literal `value:` entries in the Deployment's
 *    PodSpec. An admin password and an OAuth client secret sitting there are
 *    readable by anything that can `get deploy` in this namespace.
 *
 * 2. **A secret value passed into a `helm.v3.Chart` cannot be rotated.** The
 *    chart is rendered client-side at preview time, so if any value is unknown
 *    — which is exactly what a regenerated `RandomPassword` is — the chart
 *    cannot render and Pulumi plans to *delete every resource in it*. That is
 *    not theoretical: rotating the ntfy credential previewed as deleting
 *    Grafana's Deployment, Service, Ingress, ConfigMaps and RBAC, 11 resources
 *    in total, because that password was passed by value.
 *
 * A Secret *name* is a constant, so the chart always renders and the values
 * behind it can change freely.
 *
 * ⚠️ Keys are env var names — `envFromSecrets` maps every key to an environment
 * variable, so nothing may go in here that is not meant to be one.
 */
const GRAFANA_SECRETS_NAME = "grafana-secrets";

const grafanaSecrets = new k8s.core.v1.Secret("grafana-secrets", {
  metadata: {
    name: GRAFANA_SECRETS_NAME,
    namespace: namespaceName,
  },
  stringData: {
    GF_SECURITY_ADMIN_USER: "admin",
    GF_SECURITY_ADMIN_PASSWORD: grafanaAdminPassword.result,
    GF_AUTH_GENERIC_OAUTH_CLIENT_ID: authentikClientId,
    GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET: authentikClientSecret,
  },
});

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
 * ⚠️ Two ways to express the condition, and the choice is **not** free — it
 * decides what "no series" means, which decides whether `noDataState` is safe.
 *
 *   - **Comparison inside the PromQL** (`... < 21`, `== 0`) with `threshold: 0`.
 *     PromQL's comparison operators *filter*, so the query returns a series only
 *     while the condition holds and stage B just asks "did anything come back".
 *     ⚠️ This makes healthy indistinguishable from missing — both are empty —
 *     so it is only usable with `noDataState: "OK"`.
 *   - **Comparison in the threshold**, with the PromQL returning a bare value.
 *     The query always returns a series, so empty means the metric is genuinely
 *     absent. This is the only form that works with `noDataState: "Alerting"`.
 *
 * ⚠️ Mixing them inverts the rule. `PostgresBackupStale` shipped as
 * `... / 3600 > 36` *and* `noDataState: Alerting`: healthy backups produced no
 * series, Grafana read that as NoData, and the alert fired continuously
 * **because the backups were working**. Caught 2026-08-26, ~12 h after deploy.
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
  /**
   * Value stage B compares against, `gt`. Defaults to 0, which is correct when
   * the PromQL already filters. Set it — and drop the comparison from the
   * PromQL — whenever `noDataState` is `Alerting`. See the note above.
   */
  threshold?: number;
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
        conditions: [{ evaluator: { type: "gt", params: [r.threshold ?? 0] } }],
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
    // ⚠️ Without this, *every* edit to `alerting` or `grafana.ini` below fails
    // the deploy — and it fails on a resource nobody was thinking about.
    //
    // pulumi-kubernetes treats any change to a ConfigMap's `.data` as a
    // replacement, and replacement is create-before-delete. The chart names
    // this ConfigMap `grafana`, flatly, so the replacement collides with the
    // object that is still there:
    //
    //   creation failed: configmaps "grafana" already exists
    //
    // `local-path.ts` dodges the same trap by letting Pulumi auto-name its
    // ConfigMap; `coredns.ts` cannot, because k3s fixes the name, and it
    // reaches for `deleteBeforeReplace` exactly as here. A Helm chart's
    // rendered names are equally not ours to choose.
    //
    // The cost is a short window in which Grafana's configuration is absent.
    // Harmless here: the Deployment rolls on the same change anyway, and
    // Grafana is not on the forward-auth path — unlike Authentik, losing it
    // for a moment costs nothing but a dashboard.
    (obj: any, opts: any) => {
      if (obj.kind === "ConfigMap" && obj.metadata?.name === "grafana") {
        opts.deleteBeforeReplace = true;
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
    // ⚠️ `env` is not an option either — the chart renders those as *literal*
    // `value:` entries in the Deployment's PodSpec, readable by anyone who can
    // `get deploy` in this namespace. (Checked: they do not reach a ConfigMap,
    // as an earlier version of this comment claimed. The PodSpec is still the
    // wrong place for a credential.)
    envFromSecrets: [
      { name: GRAFANA_NTFY_SECRET_NAME },
      { name: GRAFANA_SECRETS_NAME },
    ],

    // ⚠️ Admin credentials come through the chart's own `admin.existingSecret`,
    // not through `envFromSecrets`, and that is load-bearing. With no admin
    // password in the values the chart *generates one of its own* into a
    // `grafana` Secret and wires it with `valueFrom` — and an explicit `env`
    // entry beats anything from `envFrom`, so the generated password would
    // silently win and `adminPassword` exported below would be wrong.
    //
    // Pointing the chart at the same Secret makes the two agree by
    // construction. The OAuth values have no such chart-native path and come
    // through `envFromSecrets` above.
    admin: {
      existingSecret: GRAFANA_SECRETS_NAME,
      userKey: "GF_SECURITY_ADMIN_USER",
      passwordKey: "GF_SECURITY_ADMIN_PASSWORD",
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
              // The only thing standing between an unlimited Immich quota and a
              // full pool.
              //
              // Immich's OIDC provisioning creates every family account with no
              // storage quota (`oauth.defaultStorageQuota` is unset in
              // apps/immich.ts, deliberately), and `photos.mvissing.de` is now
              // reachable from the internet — so the number of people who can
              // write to `tank` is no longer one, and none of them can see how
              // much room is left.
              //
              // ⚠️ 80%, not 90%. ZFS is not a filesystem that degrades
              // gracefully at the end: allocation shifts from first-fit to
              // best-fit around 80% and write performance falls off well before
              // the pool is actually full. On a RAIDZ1 of spinning disks that
              // is the number that matters, and `tank` also holds Time Machine,
              // the Postgres dumps and Paperless media.
              //
              // ⚠️ The threshold lives here rather than in the PromQL, so the
              // query always returns a series — see promAlert's note. That
              // makes "no series" mean the zfs exporter is gone, which is a
              // different problem and is why `noDataState` stays `OK` rather
              // than firing this rule for it.
              promAlert({
                uid: "zfs-pool-filling-up",
                title: "ZfsPoolFillingUp",
                expr: "zpool_capacity_percent",
                threshold: 80,
                // Hours, not minutes. A pool does not fill in a hurry and the
                // action this prompts — deleting snapshots, adding a quota,
                // buying a disk — is not one anybody takes at 3 a.m.
                for: "6h",
                severity: "warning",
                summary:
                  "ZFS pool {{ $labels.pool }} on {{ $labels.host }} is over 80% full",
                description:
                  "Run `zfs list -o space -s used {{ $labels.pool }}` on {{ $labels.host }} to see who grew. If it is Immich, set a per-user quota in the admin interface — Immich accounts are created without one.",
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
                // ⚠️ No `> 36` here — the comparison lives in `threshold`
                // below, so this query always returns a series and "no series"
                // can only mean the metric is absent. See promAlert's note.
                expr: "(time() - postgres_backup_last_success_timestamp_seconds) / 3600",
                threshold: 36,
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
          {
            orgId: 1,
            name: "nodes",
            folder: "Alerts",
            interval: "1m",
            // Node-level alerts, added 2026-09-13 after ionos died of memory
            // exhaustion while the whole estate was watching something else:
            // it had logged 387 journald "Under memory pressure" events since
            // Sep 1 and thrashed to death (loopback TLS handshakes timing out,
            // mount helpers taking 100× their CPU time in wall clock) without
            // a single OOM kill — the kernel reclaimed just enough for the
            // killer to never fire, and no rule existed that could notice.
            //
            // All four k3s nodes are scraped by the node-exporter DaemonSet;
            // `instance` is relabelled to the node name (prometheus.ts), so
            // {{ $labels.instance }} names the host directly.
            //
            // ⚠️ These alerts cover a node only while the overlay is up.
            // ionos's death took the overlay down with it, which is precisely
            // why they must be paired with per-node heartbeats reporting to a
            // third party (healthchecks.io) that do not traverse the mesh —
            // see the setup repo's memory-heartbeat module.
            rules: [
              // The one that would have paged today at ~16:54: a node that
              // stops being scraped. Same failure shape as PublicIngressDown
              // but at node level — the exporter vanishing is a *different*
              // problem from the node being gone, and with the overlay as the
              // only inter-site path, either half is worth a page.
              //
              // ⚠️ Two jobs, not one: the three k3s-managed nodes are scraped
              // by the node-exporter DaemonSet, but maxdata deliberately has
              // no DaemonSet pod — its native NixOS node_exporter owns :9100
              // (prometheus.ts, `job_name: "maxdata"`, static because the
              // Prometheus pod is pinned to maxdata itself). Regexp over both
              // jobs keeps all four nodes under this rule; `instance` is the
              // node name in every case.
              promAlert({
                uid: "node-exporter-down",
                title: "NodeExporterDown",
                expr: 'up{job=~"node-exporter|maxdata"} == 0',
                for: "10m",
                severity: "critical",
                summary:
                  "Node {{ $labels.instance }} has been unreachable to Prometheus for 10 minutes",
                description:
                  "The node-exporter on {{ $labels.instance }} stopped answering. Either the node is down or hung, or the overlay path to it is broken. Since 2026-09-13 this is the alert that fires when the control-plane node dies, because the overlay dies with it and the node's own heartbeat cannot reach ntfy either — the per-node healthchecks.io heartbeats are what catch the node when the overlay is the casualty.",
              }),
              // PSI is the direct measurement of the failure mode that killed
              // ionos: not low memory, but *stalled* memory. MemAvailable can
              // look acceptable while the kernel spends its time evicting page
              // cache (that is exactly what journald was complaining about for
              // 12 days), so the availability ratio alone is too late a
              // signal. `stalled_seconds` counts seconds where *all* memory
              // tasks were blocked; rate() over 5 m gives the fraction of time
              // the node was fully stalled, 0..1.
              //
              // Bare-value form with the threshold in stage B: healthy nodes
              // return ~0, so the series is always present and "no series"
              // can only mean an exporter too old for PSI — not worth paging.
              promAlert({
                uid: "node-memory-stalled",
                title: "NodeMemoryStalled",
                expr: "rate(node_pressure_memory_stalled_seconds_total[5m])",
                threshold: 0.1,
                for: "10m",
                severity: "critical",
                summary:
                  "Node {{ $labels.instance }} is stalled on memory 10% of the time",
                description:
                  "Kernel PSI shows every memory-relevant task blocked >10% of the last 5 minutes. This is the state ionos spent its last hours in before the 2026-09-13 power-cycle. Find the consumer: `ps aux --sort=-rss` on {{ $labels.instance }}; on ionos expect k3s to be it. If it recurs, the 1851 MB / no-swap budget needs revisiting, not just the alert.",
              }),
              // Secondary, threshold-form for the same no-data reasoning: an
              // always-present ratio, so "no series" means the exporter is
              // gone (covered by NodeExporterDown) rather than the node being
              // out of memory.
              promAlert({
                uid: "node-memory-available-low",
                title: "NodeMemoryAvailableLow",
                expr: "1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)",
                threshold: 0.9,
                for: "15m",
                severity: "warning",
                summary:
                  "Node {{ $labels.instance }} has under 10% memory available for 15 minutes",
                description:
                  "Early heads-up before the stalls begin. `ps aux --sort=-rss` on {{ $labels.instance }}. A node under this condition is one noisy workload away from the thrash NodeMemoryStalled catches.",
              }),
              // Kernel actually invoked the OOM killer. Counter resets only on
              // reboot, so increase() is safe; `for: 0m` is right — the event
              // already happened. Warning rather than critical because a
              // caught kill may be absorbed (k3s restarts the pod), while the
              // *state* of the node is what NodeMemoryStalled covers.
              promAlert({
                uid: "node-oom-kill",
                title: "NodeOOMKill",
                expr: "increase(node_vmstat_oom_kill[10m]) > 0",
                for: "0m",
                severity: "warning",
                summary:
                  "Node {{ $labels.instance }} OOM-killed a process in the last 10 minutes",
                description:
                  "The kernel memory cgroup or the kernel itself killed a process on {{ $labels.instance }}. Find the victim in the journal: `journalctl -k --since -15m | grep -i oom`. maxdata carried 101 lifetime OOM kills before this alert existed.",
              }),
              // unpoller exports this counter every time a controller fetch
              // fails. It earned its place the hard way: the poller failed to
              // authenticate from 2026-09-05 (UOS Server migration never
              // migrated its user), tripped UOS's login-attempt limit into a
              // self-sustaining 429 lockout, and exported zero controller
              // data for 10 days — while the Deployment read 1/1 Running,
              // because a poller's /metrics endpoint stays alive and serves
              // only self-metrics while its fetches fail. This alert is what
              // makes that shape visible.
              promAlert({
                uid: "unpoller-refresh-failing",
                title: "UnpollerRefreshFailing",
                expr: "increase(unpoller_prometheus_refresh_failures_total[30m]) > 0",
                for: "0m",
                severity: "warning",
                summary:
                  "unpoller failed {{ $values.A }} controller refreshes in 30 minutes",
                description:
                  "The poller cannot fetch from the UniFi controller — unifi dashboards are silently going stale. Check `kubectl logs -n monitoring deploy/unpoller` for the failure shape: 429 means the controller's login-attempt limit (scale the poller to 0 and let it cool); 403 means the credentials/API key are rejected. Note the Deployment stays 1/1 while this fires — the /metrics endpoint lives even when every controller fetch fails.",
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
// 1. Authentik OAuth — now code, not clicks: the provider and application are
//    declared in this file (see the Authentik OAuth section), managed through
//    the API provider configured by authentik:url / authentik:token in stack
//    config (see auth/authentik-config.ts). The client credentials flow from
//    the provider resource itself — nothing to copy into stack config.
//    Authorization is admins-group membership (grafana-group-binding).
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
