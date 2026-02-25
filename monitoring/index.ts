// Monitoring Stack
// Complete observability setup with Prometheus, Grafana, Loki, and Tempo
// All components use local-path storage (ZFS backed) with automatic snapshots

// Import all monitoring components in dependency order
import "./namespace";         // Create namespace first
import "./prometheus";        // Metrics collection
import "./loki";             // Log aggregation backend
import "./promtail";         // Log collection agent (requires Loki)
import "./tempo";            // Distributed tracing
import "./ntfy";             // Push notification service
import "./grafana-database"; // Grafana PostgreSQL database
import "./grafana";          // Visualization and dashboards (requires all data sources)
import "./unpoller";         // UniFi metrics exporter for Prometheus

// Re-export for external use if needed
export * from "./namespace";
export * from "./prometheus";
export * from "./loki";
export * from "./promtail";
export * from "./tempo";
export * from "./ntfy";
export * from "./grafana";
export * from "./unpoller";

// Monitoring Stack Overview:
//
// Components deployed:
//   - Prometheus: Metrics collection and storage (365d retention, 100Gi)
//   - AlertManager: Alert handling (included with Prometheus)
//   - Node Exporter: Node-level metrics (DaemonSet on all nodes)
//   - Kube State Metrics: Cluster state metrics
//   - Loki: Log aggregation backend (365d retention, 100Gi)
//   - Promtail: Log collection agent (DaemonSet on all nodes)
//   - Tempo: Distributed tracing backend (30d retention, 50Gi)
//   - Grafana: Unified visualization with Authentik OAuth
//   - Diun: Container image update notifier (checks every 6h)
//   - Nova: Helm chart update checker (CronJob every 6h)
//
// Public endpoints (via traefik-external with Let's Encrypt):
//   - https://grafana.mvissing.de - Main dashboard UI
//   - https://prometheus.mvissing.de - Prometheus UI (for advanced queries)
//
// Internal endpoints (cluster-only):
//   - http://prometheus-server.monitoring.svc.cluster.local - Prometheus
//   - http://loki.monitoring.svc.cluster.local:3100 - Loki
//   - http://tempo.monitoring.svc.cluster.local:3100 - Tempo query
//   - http://tempo.monitoring.svc.cluster.local:4317 - Tempo OTLP gRPC
//   - http://tempo.monitoring.svc.cluster.local:4318 - Tempo OTLP HTTP
//
// Storage (all on local-path with ZFS backing):
//   - Prometheus: 100Gi (metrics, 1 year retention)
//   - Loki: 100Gi (logs, 1 year retention)
//   - Tempo: 50Gi (traces, 30 days retention)
//   - Grafana: 2Gi (plugins only - dashboards/config in PostgreSQL)
//   - AlertManager: 5Gi
//   - PostgreSQL: Shared database (Grafana data stored here)
//
// Total storage required: ~257Gi
//
// Setup checklist:
// [ ] Create Authentik OAuth2 provider for Grafana
// [ ] Set Pulumi config secrets (see grafana.ts for details)
// [ ] Deploy with: pulumi up
// [ ] Verify all pods are running: kubectl get pods -n monitoring
// [ ] Access Grafana at https://grafana.mvissing.de
// [ ] Configure alert rules in Prometheus (optional)
// [ ] Add custom dashboards in Grafana (optional)