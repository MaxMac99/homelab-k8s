// GitHub Actions Runner Controller (ARC) v2
// Deploys a self-hosted runner scale set for CI/CD pipelines

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config("k8s-resources");

// Namespaces
const arcSystemsNamespace = new k8s.core.v1.Namespace("arc-systems", {
  metadata: { name: "arc-systems" },
});

const arcRunnersNamespace = new k8s.core.v1.Namespace("arc-runners", {
  metadata: { name: "arc-runners" },
});

// GitHub PAT secret for runner authentication
const githubPatSecret = new k8s.core.v1.Secret("github-pat", {
  metadata: {
    name: "github-pat",
    namespace: arcRunnersNamespace.metadata.name,
  },
  stringData: {
    github_token: config.requireSecret("githubPat"),
  },
});

// ARC controller
const arcController = new k8s.helm.v3.Release("arc-controller", {
  chart: "oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller",
  version: "0.13.1",
  namespace: arcSystemsNamespace.metadata.name,
});

// ServiceAccount for runner pods (needs cluster-admin for pulumi up)
const arcRunnerSA = new k8s.core.v1.ServiceAccount("arc-runner", {
  metadata: {
    name: "arc-runner",
    namespace: arcRunnersNamespace.metadata.name,
  },
});

const arcRunnerClusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding(
  "arc-runner-cluster-admin",
  {
    metadata: { name: "arc-runner-cluster-admin" },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "cluster-admin",
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: "arc-runner",
        namespace: "arc-runners",
      },
    ],
  }
);

// ARC runner scale set
const arcRunnerScaleSet = new k8s.helm.v3.Release(
  "arc-runner-set",
  {
    chart: "oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set",
    version: "0.13.1",
    namespace: arcRunnersNamespace.metadata.name,
    values: {
      githubConfigUrl: "https://github.com/MaxMac99/homelab-k8s",
      githubConfigSecret: githubPatSecret.metadata.name,
      minRunners: 0,
      maxRunners: 3,
      runnerScaleSetName: "homelab-runner",
      template: {
        spec: {
          serviceAccountName: "arc-runner",
          nodeSelector: {
            "kubernetes.io/arch": "amd64",
          },
          containers: [
            {
              name: "runner",
              image: "ghcr.io/actions/actions-runner:latest",
              command: ["/home/runner/run.sh"],
            },
          ],
        },
      },
    },
  },
  { dependsOn: [arcController, arcRunnerSA, arcRunnerClusterRoleBinding] }
);

export {
  arcController,
  arcRunnerScaleSet,
  arcRunnerSA,
  arcRunnerClusterRoleBinding,
};
