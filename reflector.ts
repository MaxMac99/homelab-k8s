// Reflector - Automatically copies/mirrors secrets and configmaps across namespaces
// Used to sync database credentials from database namespace to application namespaces

import * as k8s from "@pulumi/kubernetes";

// Install Reflector using Helm
const reflector = new k8s.helm.v3.Chart("reflector", {
  chart: "reflector",
  version: "9.1.41",
  namespace: "kube-system", // Deploy to kube-system namespace
  fetchOpts: {
    repo: "https://emberstack.github.io/helm-charts",
  },
  values: {
    // Reflector configuration
    // Default settings are fine for most use cases
  },
});

export { reflector };

// Usage:
// Annotate secrets in the source namespace with:
//   reflector.v1.k8s.emberstack.com/reflection-allowed: "true"
//   reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: "namespace1,namespace2"
//
// Or to reflect to all namespaces matching a pattern:
//   reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
//   reflector.v1.k8s.emberstack.com/reflection-auto-namespaces: "^namespace-.*$"