// Tempo - Distributed tracing backend
// Stores and queries traces from instrumented applications
// Integrates with Grafana for visualization

import * as k8s from "@pulumi/kubernetes";
import { namespaceName } from "./namespace";

// Install Tempo using Helm chart (single binary mode for simplicity)
const tempo = new k8s.helm.v3.Chart("tempo", {
  chart: "tempo",
  version: "1.24.1",
  namespace: namespaceName,
  fetchOpts: {
    repo: "https://grafana.github.io/helm-charts",
  },
  values: {
    // Tempo configuration
    tempo: {
      // Storage - use local filesystem
      storage: {
        trace: {
          backend: "local",
          local: {
            path: "/var/tempo/traces",
          },
        },
      },

      // Receivers - what trace formats to accept
      receivers: {
        // Jaeger receiver
        jaeger: {
          protocols: {
            grpc: {
              endpoint: "0.0.0.0:14250",
            },
            thrift_http: {
              endpoint: "0.0.0.0:14268",
            },
            thrift_compact: {
              endpoint: "0.0.0.0:6831",
            },
          },
        },
        // Zipkin receiver
        zipkin: {
          endpoint: "0.0.0.0:9411",
        },
        // OTLP receiver (OpenTelemetry)
        otlp: {
          protocols: {
            grpc: {
              endpoint: "0.0.0.0:4317",
            },
            http: {
              endpoint: "0.0.0.0:4318",
            },
          },
        },
      },

      // Retention - keep traces for 30 days
      retention: "720h", // 30 days in hours
    },

    // Persistent storage for traces using local-path (ZFS backed)
    persistence: {
      enabled: true,
      storageClassName: "local-path",
      size: "50Gi",
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

    // Service configuration
    service: {
      type: "ClusterIP",
    },
  },
});

// Export Tempo service URLs for Grafana data source and application instrumentation
export const tempoQueryUrl = "http://tempo.monitoring.svc.cluster.local:3100";
export const tempoOtlpGrpcUrl = "http://tempo.monitoring.svc.cluster.local:4317";
export const tempoOtlpHttpUrl = "http://tempo.monitoring.svc.cluster.local:4318";
export const tempoJaegerGrpcUrl = "http://tempo.monitoring.svc.cluster.local:14250";

export { tempo };

// Usage:
//
// Tempo is queried through Grafana - no direct UI
//
// To send traces to Tempo from your applications:
//
// 1. OpenTelemetry (recommended):
//    - OTLP gRPC endpoint: tempo.monitoring.svc.cluster.local:4317
//    - OTLP HTTP endpoint: tempo.monitoring.svc.cluster.local:4318
//
// 2. Jaeger:
//    - Jaeger gRPC endpoint: tempo.monitoring.svc.cluster.local:14250
//    - Jaeger Thrift HTTP: tempo.monitoring.svc.cluster.local:14268
//
// 3. Zipkin:
//    - Zipkin endpoint: http://tempo.monitoring.svc.cluster.local:9411
//
// Example (Node.js with OpenTelemetry):
//   const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
//   const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
//
//   const exporter = new OTLPTraceExporter({
//     url: 'tempo.monitoring.svc.cluster.local:4317',
//   });
//
//   const provider = new NodeTracerProvider();
//   provider.addSpanProcessor(new BatchSpanProcessor(exporter));
//   provider.register();
//
// Query traces in Grafana:
//   - Go to Explore
//   - Select Tempo data source
//   - Search by trace ID, service name, or other attributes
//
// Retention: 30 days
// Storage: 50Gi on local-path (ZFS backed with automatic sanoid snapshots)