// Grafana dashboards, provisioned as code.
//
// Imported by monitoring/grafana.ts into the chart's `dashboards` values —
// re-imported on every Grafana restart, and stored in the PostgreSQL
// dashboard database like any UI-created dashboard (editable, deletable).
//
// "Kubernetes Logs" — the drill-down chain runs namespace -> service -> pod,
// and each variable's query is scoped by the ones above it:
//
//   namespace  label_values(namespace)
//   service    label_values({namespace=~"$namespace"}, app)
//   pod        label_values({namespace=~"$namespace", app=~"$service"}, pod)
//
// ⚠️ The "service" level is the `app` label, which Alloy (monitoring/alloy.ts)
// populates from the pod label `app` with a fallback to
// `app.kubernetes.io/name`. Alloy's labelmap copies the raw
// `app_kubernetes_io_name` label too, but the dashboard deliberately filters
// on the normalized `app` so one dropdown covers both label styles.
//
// ⚠️ The allValue split is load-bearing, and `.*` everywhere is WRONG.
// Loki rejects a stream selector whose EVERY matcher is "empty-compatible"
// (a regex that also matches the empty string): `.*` does, `.+` does not.
// With all three variables on All and `.*` allValues, every panel failed
// with `parse error : queries require at least one regexp or equality
// matcher that does not have an empty-compatible value`. So namespace and
// pod get `.+` — those labels exist non-empty on every pod-log stream and
// carry the query's validity — while service keeps `.*`: an `app` matcher
// matching empty also matches streams WITHOUT the label, which is what
// keeps "All" including the historical logs from before the Alloy app
// fallback (everything before 2026-10-03 has no `app` label at all). One
// non-empty-compatible matcher anywhere in the selector is enough for
// Loki to accept it. Corollary: the journal streams (no namespace label)
// are structurally outside this dashboard — they have no
// namespace/service/pod shape to drill into.

// Same pinning rationale as PROMETHEUS_DS_UID in grafana.ts: dashboards
// reference datasources by uid, and a derived hash uid is not a contract.
// Provisioning updates the existing datasource in place, so adopting a
// readable uid breaks nothing.
export const LOKI_DS_UID = "loki";

const lokiDs = { type: "loki", uid: LOKI_DS_UID };

const lokiVariable = {
  datasource: lokiDs,
  current: { selected: false, text: "All", value: "$__all" },
  includeAll: true,
  multi: true,
  options: [],
  refresh: 2, // on dashboard load, so the chain re-scopes on every visit
  regex: "",
  skipUrlSync: false,
  sort: 1,
  type: "query",
};

// Namespace and pod exist non-empty on every pod-log stream, so their
// "All" is `.+` — it matches everything while keeping the selector valid
// for Loki (see the header note). Service keeps `.*` so its "All" also
// includes the pre-fallback streams that have no `app` label.
const alwaysPresentAll = ".+";
const withAbsentLabelAll = ".*";

const logSelector = '{namespace=~"$namespace", app=~"$service", pod=~"$pod"}';

const dashboard = {
  uid: "k8s-logs",
  title: "Kubernetes Logs",
  description:
    "Pod logs from Loki, filtered by namespace, service and pod. " +
    "The service dropdown comes from the `app` log label (Alloy).",
  tags: ["kubernetes", "logs", "loki"],
  timezone: "browser",
  editable: true,
  graphTooltip: 1,
  refresh: "30s",
  schemaVersion: 39,
  version: 1,
  time: { from: "now-6h", to: "now" },
  timepicker: {},
  templating: {
    list: [
      {
        ...lokiVariable,
        name: "namespace",
        label: "Namespace",
        allValue: alwaysPresentAll,
        definition: "label_values(namespace)",
        query: "label_values(namespace)",
      },
      {
        ...lokiVariable,
        name: "service",
        label: "Service",
        allValue: withAbsentLabelAll,
        definition: 'label_values({namespace=~"$namespace"}, app)',
        query: 'label_values({namespace=~"$namespace"}, app)',
      },
      {
        ...lokiVariable,
        name: "pod",
        label: "Pod",
        allValue: alwaysPresentAll,
        definition:
          'label_values({namespace=~"$namespace", app=~"$service"}, pod)',
        query: 'label_values({namespace=~"$namespace", app=~"$service"}, pod)',
      },
    ],
  },
  panels: [
    {
      id: 1,
      type: "timeseries",
      title: "Log lines by service",
      description: "Which services are writing logs in the selected scope.",
      datasource: lokiDs,
      gridPos: { h: 7, w: 24, x: 0, y: 0 },
      fieldConfig: {
        defaults: {
          unit: "short",
          min: 0,
          custom: {
            drawStyle: "line",
            lineWidth: 1,
            fillOpacity: 10,
            showPoints: "never",
            spanNulls: false,
          },
        },
        overrides: [],
      },
      options: {
        legend: { displayMode: "table", placement: "bottom", calcs: ["max"] },
        tooltip: { mode: "multi", sort: "desc" },
      },
      targets: [
        {
          refId: "A",
          queryType: "range",
          datasource: lokiDs,
          legendFormat: "{{app}}",
          expr:
            "sum by (app) (count_over_time(" + logSelector + "[$__interval]))",
        },
      ],
    },
    {
      id: 2,
      type: "logs",
      title: "Logs",
      datasource: lokiDs,
      gridPos: { h: 17, w: 24, x: 0, y: 7 },
      fieldConfig: { defaults: {}, overrides: [] },
      options: {
        showTime: true,
        showLabels: true,
        showCommonLabels: false,
        wrapLogMessage: true,
        prettifyLogMessage: false,
        enableLogDetails: true,
        sortOrder: "Descending",
        dedupStrategy: "none",
      },
      targets: [
        {
          refId: "A",
          queryType: "range",
          datasource: lokiDs,
          expr: logSelector,
        },
      ],
    },
  ],
};

export const kubernetesLogsDashboard = JSON.stringify(dashboard, null, 2);
