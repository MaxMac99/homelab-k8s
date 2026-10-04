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

// PAT für das Foreman-Runner-Set (repo-scoped auf MaxMac99/Foreman).
// App-Auth wäre die rotation-freie Alternative — für Konsistenz mit dem
// bestehenden Set zuerst PAT (Upgrade-Pfad: GitHub App, D-014-Anmerkung).
const foremanRunnerPatSecret = new k8s.core.v1.Secret("github-pat-foreman", {
  metadata: {
    name: "github-pat-foreman",
    namespace: arcRunnersNamespace.metadata.name,
  },
  stringData: {
    github_token: config.requireSecret("foremanRunnerPat"),
  },
});

// ARC controller
const arcController = new k8s.helm.v3.Release("arc-controller", {
  chart:
    "oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller",
  version: "0.15.0",
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
  },
);

// ARC runner scale set
const arcRunnerScaleSet = new k8s.helm.v3.Release(
  "arc-runner-set",
  {
    chart:
      "oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set",
    version: "0.15.0",
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
  { dependsOn: [arcController, arcRunnerSA, arcRunnerClusterRoleBinding] },
);

// Foreman-Runner-Set (2026-10-03): zweites Scale-Set für MaxMac99/Foreman —
// ein Scale-Set bindet an genau eine GitHub-Entität, User-Accounts haben
// keine Org-Ebene (Doku-verified). Wie homelab-runner: minRunners 0 (keine
// Idle-Pods), ephemere Runner. containerMode dind: die Release-Workflows
// bauen/pushen Docker-Images (dockerTools.load → docker push + Smoke) —
// ohne Docker-Daemon würden die Jobs am fehlenden `docker` scheitern.
// Nix kommt pro Job via nix-installer-action; der Binary-Cache (attic,
// namespace foreman) liegt über ClusterIP/LAN in Reichweite.
const foremanRunnerScaleSet = new k8s.helm.v3.Release(
  "foreman-runner-set",
  {
    chart:
      "oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set",
    version: "0.15.0",
    namespace: arcRunnersNamespace.metadata.name,
    values: {
      githubConfigUrl: "https://github.com/MaxMac99/Foreman",
      githubConfigSecret: foremanRunnerPatSecret.metadata.name,
      minRunners: 0,
      maxRunners: 3,
      runnerScaleSetName: "foreman-runner",
      containerMode: { type: "dind" },
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
  { dependsOn: [arcController, arcRunnerSA, arcRunnerClusterRoleBinding] },
);

export {
  arcController,
  arcRunnerScaleSet,
  foremanRunnerScaleSet,
  arcRunnerSA,
  arcRunnerClusterRoleBinding,
};
