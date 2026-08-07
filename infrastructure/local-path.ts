// local-path-provisioner — node-local PersistentVolumes backed by ZFS.
//
// k3s runs with `--disable=local-storage`, so no provisioner ships by default
// and every `local-path` PVC in this repo would sit Pending forever. It used
// to be deployed by NixOS, pinned to a virtiofs path that died with the
// microVMs.
//
// It lives here rather than in NixOS because nothing at boot needs it: the
// layering rule gives NixOS only what must exist before the cluster does. What
// NixOS (or rather the host) still owns is the *filesystem* underneath — the
// ZFS datasets below are created on the box, since D13 leaves data datasets to
// `zfs-mount.service` rather than declaring them.
//
// ⚠️ A local-path volume is node-local and has no replica anywhere (D6).
// Losing the node loses the volume. Every workload holding one is pinned to a
// specific node, not merely to a site — see infrastructure/sites.ts.

import * as k8s from "@pulumi/kubernetes";
import { BRINK_SERVER, MAXDATA } from "./sites";

const namespace = new k8s.core.v1.Namespace("local-path-storage", {
  metadata: { name: "local-path-storage" },
});

/**
 * Where each node keeps its volumes.
 *
 * Per-node because the four machines have genuinely different disks — this is
 * not a path that could be made uniform. Both entries sit on a ZFS dataset so
 * sanoid snapshots cover them.
 *
 * ⚠️ Two nodes are deliberately absent, and absence is the point: a node with
 * no entry and no `DEFAULT_PATH_FOR_NON_LISTED_NODES` fails provisioning
 * loudly instead of quietly writing to the root filesystem.
 *   - `ionos` — a VPS with a small disk, and tainted `edge=true:NoSchedule`.
 *   - `winkel-pi` — boots from USB-SATA. Nothing here belongs on it.
 */
const nodePathMap = [
  // Existing dataset `fast/k8s` (NVMe pool, mounted at /fast/k8s).
  // A fresh subdirectory, not the old `local-path-provisioner/` beside it —
  // that still holds the previous cluster's volumes and is left untouched
  // until Phase 11 proves the backups.
  { node: MAXDATA, paths: ["/fast/k8s/local-path"] },
  // Dataset `main/k8s` — but note the mountpoint is `/var/lib/k8s`, not
  // `/main/k8s`. brink-server's pool has `mountpoint=none` and every dataset
  // carries an explicit one, so `/main` does not exist at all. Verified on the
  // box: `main/k8s  mounted yes  mountpoint /var/lib/k8s`.
  { node: BRINK_SERVER, paths: ["/var/lib/k8s/local-path"] },
];

// Deliberately auto-named — no `metadata.name`.
//
// pulumi-kubernetes replaces a ConfigMap whenever `.data` changes rather than
// updating it in place, and replacement is create-before-delete. With a fixed
// name the new object collides with the one still present and the update fails
// outright ("configmaps \\"local-path-config\\" already exists").
//
// Auto-naming also fixes a quieter problem: the Deployment mounts this by
// name, so with a fixed name a `nodePathMap` edit would change the ConfigMap
// without restarting the provisioner — the running process would keep serving
// the old paths. A new name forces the Deployment to roll.
const config = new k8s.core.v1.ConfigMap("local-path-config", {
  metadata: {
    namespace: namespace.metadata.name,
  },
  data: {
    "config.json": JSON.stringify({ nodePathMap }, null, 2),
    // Upstream's default setup/teardown scripts, inlined because the ConfigMap
    // must carry all four keys or the provisioner refuses to start.
    setup: `#!/bin/sh
set -eu
mkdir -m 0777 -p "$VOL_DIR"
`,
    teardown: `#!/bin/sh
set -eu
rm -rf "$VOL_DIR"
`,
    "helperPod.yaml": `apiVersion: v1
kind: Pod
metadata:
  name: helper-pod
spec:
  priorityClassName: system-node-critical
  tolerations:
    - key: node.kubernetes.io/disk-pressure
      operator: Exists
      effect: NoSchedule
  containers:
    - name: helper-pod
      image: busybox:1.37.0
      imagePullPolicy: IfNotPresent
`,
  },
});

const serviceAccount = new k8s.core.v1.ServiceAccount("local-path-sa", {
  metadata: {
    name: "local-path-provisioner-service-account",
    namespace: namespace.metadata.name,
  },
});

const clusterRole = new k8s.rbac.v1.ClusterRole("local-path-role", {
  metadata: { name: "local-path-provisioner-role" },
  rules: [
    {
      apiGroups: [""],
      resources: [
        "nodes",
        "persistentvolumeclaims",
        "configmaps",
        "pods",
        "pods/log",
      ],
      verbs: ["get", "list", "watch"],
    },
    {
      apiGroups: [""],
      resources: ["persistentvolumes"],
      verbs: ["get", "list", "watch", "create", "patch", "update", "delete"],
    },
    {
      apiGroups: [""],
      resources: ["events"],
      verbs: ["create", "patch"],
    },
    {
      apiGroups: [""],
      resources: ["pods"],
      verbs: ["create", "delete"],
    },
    {
      apiGroups: ["storage.k8s.io"],
      resources: ["storageclasses"],
      verbs: ["get", "list", "watch"],
    },
  ],
});

const clusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding(
  "local-path-binding",
  {
    metadata: { name: "local-path-provisioner-bind" },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: clusterRole.metadata.name,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: serviceAccount.metadata.name,
        namespace: namespace.metadata.name,
      },
    ],
  },
);

const deployment = new k8s.apps.v1.Deployment(
  "local-path-provisioner",
  {
    metadata: {
      name: "local-path-provisioner",
      namespace: namespace.metadata.name,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: "local-path-provisioner" } },
      template: {
        metadata: { labels: { app: "local-path-provisioner" } },
        spec: {
          serviceAccountName: serviceAccount.metadata.name,
          // The controller itself holds no state and can run on any node that
          // will have it. ionos excludes itself via its taint.
          containers: [
            {
              name: "local-path-provisioner",
              image: "rancher/local-path-provisioner:v0.0.37",
              imagePullPolicy: "IfNotPresent",
              command: [
                "local-path-provisioner",
                "--debug",
                "start",
                "--config",
                "/etc/config/config.json",
                "--service-account-name",
                "local-path-provisioner-service-account",
                // ⚠️ Load-bearing with the auto-named ConfigMap above.
                //
                // The provisioner does not only read its own config from this
                // ConfigMap — it builds every helper pod with a volume
                // referencing it *by name*, and that name defaults to the
                // literal "local-path-config". Auto-naming without this flag
                // leaves the helper pod mounting a ConfigMap that does not
                // exist: it sits in ContainerCreating, the provisioner times
                // out after 120 s, deletes it and retries forever. The PVC
                // stays Pending and the only clue is a FailedMount event on a
                // pod that is deleted before you can look at it.
                //
                // Passing the resolved name also keeps the two in step: the
                // arg changes whenever the ConfigMap is replaced, so the
                // Deployment rolls with it.
                "--configmap-name",
                config.metadata.name,
              ],
              volumeMounts: [
                { name: "config-volume", mountPath: "/etc/config/" },
              ],
              env: [
                {
                  name: "POD_NAMESPACE",
                  valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } },
                },
                { name: "CONFIG_MOUNT_PATH", value: "/etc/config/" },
              ],
            },
          ],
          volumes: [
            {
              name: "config-volume",
              configMap: { name: config.metadata.name },
            },
          ],
        },
      },
    },
  },
  { dependsOn: [clusterRoleBinding, config] },
);

// The StorageClass every `local-path` PVC in this repo names.
//
// `WaitForFirstConsumer` is load-bearing, not a default worth skipping: it
// delays binding until the pod is scheduled, so the workload's nodeSelector
// decides which node's disk is used. With `Immediate` the provisioner would
// pick a node first and the pod would then be unschedulable anywhere else.
//
// `Retain` departs from upstream's `Delete`. These volumes have no replica and
// no cross-site copy; deleting a PVC by accident would be unrecoverable
// between snapshots. The cost is orphaned directories to clean up by hand.
const storageClass = new k8s.storage.v1.StorageClass(
  "local-path",
  {
    metadata: {
      name: "local-path",
      annotations: {
        // Not default: a PVC that forgets to name a class should fail rather
        // than silently acquire an unreplicated node-local volume.
        "storageclass.kubernetes.io/is-default-class": "false",
      },
    },
    provisioner: "rancher.io/local-path",
    volumeBindingMode: "WaitForFirstConsumer",
    reclaimPolicy: "Retain",
  },
  { dependsOn: [deployment] },
);

export { namespace, config, deployment, storageClass };
