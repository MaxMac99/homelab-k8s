// UniFi OS Server - self-hosted UniFi OS (Network + Org/IdP/Site Magic features)
//
// Replaces the previous LinuxServer.io UniFi Network Application. UniFi OS
// Server (UOS) is a monolithic appliance image that bundles its OWN MongoDB,
// PostgreSQL, RabbitMQ, nginx and the Java/Go services, all running as systemd
// services with systemd as PID 1. Because of that it:
//   - does NOT use the shared MongoDB in databases/mongodb.ts (bundled instead)
//   - requires a PRIVILEGED container with host cgroup access + NET_ADMIN/NET_RAW
//
// Image is the community build that re-packages Ubiquiti's official installer:
//   https://github.com/chrissnell/unifi-os-kubernetes
//
// Migration from the old Network Application:
//   - The shared-MongoDB init Job / secret are gone (UOS owns its DB).
//   - Restore your existing UniFi Network `.unf` backup via the UOS web UI.
//   - Web UI moved from :8443 to :443; discovery from :10001 to :10003.
// See the Setup / Migration notes at the bottom of this file.

import * as k8s from "@pulumi/kubernetes";

// Create namespace for UniFi
const namespace = new k8s.core.v1.Namespace("unifi", {
  metadata: {
    name: "unifi",
  },
});

// PVC for main UOS state: config, /persistent, /data, /srv, network app data,
// logs and rabbitmq SSL (mounted via subPaths below).
const unifiDataPVC = new k8s.core.v1.PersistentVolumeClaim("unifi-data-pvc", {
  metadata: {
    name: "unifi-data",
    namespace: namespace.metadata.name,
  },
  spec: {
    accessModes: ["ReadWriteOnce"],
    storageClassName: "local-path",
    resources: {
      requests: {
        storage: "20Gi",
      },
    },
  },
});

// PVC for the bundled MongoDB datadir (/var/lib/mongodb). Kept separate so the
// database can be sized / snapshotted independently of the rest of UOS state.
const unifiMongoPVC = new k8s.core.v1.PersistentVolumeClaim("unifi-mongo-pvc", {
  metadata: {
    name: "unifi-mongo",
    namespace: namespace.metadata.name,
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

// UniFi OS Server Deployment
const unifiDeployment = new k8s.apps.v1.Deployment(
  "unifi",
  {
    metadata: {
      name: "unifi",
      namespace: namespace.metadata.name,
      labels: {
        app: "unifi",
      },
    },
    spec: {
      replicas: 1,
      // Stateful appliance on RWO volumes: tear the old pod down before the new
      // one starts so the volumes aren't double-mounted.
      strategy: {
        type: "Recreate",
      },
      selector: {
        matchLabels: {
          app: "unifi",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "unifi",
          },
        },
        spec: {
          nodeSelector: {
            "kubernetes.io/arch": "amd64",
          },
          containers: [
            {
              name: "unifi-os-server",
              image: "ghcr.io/chrissnell/unifi-os-server:5.0.8",
              // UOS runs systemd and bundled services as root and needs host
              // cgroup access; privileged is the only reliable mode today.
              securityContext: {
                privileged: true,
                capabilities: {
                  add: ["NET_ADMIN", "NET_RAW"],
                },
              },
              ports: [
                {
                  containerPort: 443,
                  name: "https",
                  protocol: "TCP",
                },
                {
                  containerPort: 8080,
                  name: "inform",
                  protocol: "TCP",
                },
                {
                  containerPort: 3478,
                  name: "stun",
                  protocol: "UDP",
                },
                {
                  containerPort: 10003,
                  name: "discovery",
                  protocol: "UDP",
                },
              ],
              // Optionally pin the address UOS advertises to devices/controllers
              // once you know the LoadBalancer IP (see migration notes):
              //   env: [{ name: "UOS_SYSTEM_IP", value: "192.168.178.XX" }],
              resources: {
                requests: {
                  memory: "2Gi",
                  cpu: "500m",
                },
                limits: {
                  memory: "6Gi",
                  cpu: "4",
                },
              },
              // Bundled nginx serves /api/ping on :80. First boot runs a full
              // systemd init and can take several minutes.
              livenessProbe: {
                httpGet: {
                  path: "/api/ping",
                  port: 80,
                },
                initialDelaySeconds: 180,
                periodSeconds: 60,
                timeoutSeconds: 10,
                failureThreshold: 5,
              },
              readinessProbe: {
                httpGet: {
                  path: "/api/ping",
                  port: 80,
                },
                initialDelaySeconds: 60,
                periodSeconds: 15,
                timeoutSeconds: 5,
                failureThreshold: 10,
              },
              volumeMounts: [
                // Host cgroup mount so systemd-in-container works.
                {
                  name: "cgroup",
                  mountPath: "/sys/fs/cgroup",
                },
                // Writable tmpfs mounts required by systemd / UniFi.
                { name: "tmp-run", mountPath: "/run" },
                { name: "tmp-run-lock", mountPath: "/run/lock" },
                { name: "tmp-tmp", mountPath: "/tmp" },
                { name: "tmp-journal", mountPath: "/var/lib/journal" },
                { name: "tmp-unifi", mountPath: "/var/opt/unifi/tmp" },
                // Persistent UOS state, split across paths via subPaths.
                {
                  name: "data",
                  mountPath: "/persistent",
                  subPath: "persistent",
                },
                { name: "data", mountPath: "/var/log", subPath: "log" },
                { name: "data", mountPath: "/data", subPath: "data" },
                { name: "data", mountPath: "/srv", subPath: "srv" },
                { name: "data", mountPath: "/var/lib/unifi", subPath: "unifi" },
                {
                  name: "data",
                  mountPath: "/etc/rabbitmq/ssl",
                  subPath: "rabbitmq-ssl",
                },
                // Bundled MongoDB datadir on its own PVC.
                { name: "mongo", mountPath: "/var/lib/mongodb" },
              ],
            },
          ],
          volumes: [
            {
              name: "cgroup",
              hostPath: {
                path: "/sys/fs/cgroup",
              },
            },
            { name: "tmp-run", emptyDir: { medium: "Memory" } },
            { name: "tmp-run-lock", emptyDir: { medium: "Memory" } },
            { name: "tmp-tmp", emptyDir: { medium: "Memory" } },
            { name: "tmp-journal", emptyDir: { medium: "Memory" } },
            {
              name: "tmp-unifi",
              emptyDir: { medium: "Memory", sizeLimit: "64Mi" },
            },
            {
              name: "data",
              persistentVolumeClaim: {
                claimName: unifiDataPVC.metadata.name,
              },
            },
            {
              name: "mongo",
              persistentVolumeClaim: {
                claimName: unifiMongoPVC.metadata.name,
              },
            },
          ],
        },
      },
    },
  },
  { dependsOn: [unifiDataPVC, unifiMongoPVC] },
);

// UniFi LoadBalancer Service
const unifiService = new k8s.core.v1.Service("unifi-service", {
  metadata: {
    name: "unifi",
    namespace: namespace.metadata.name,
  },
  spec: {
    type: "LoadBalancer",
    selector: {
      app: "unifi",
    },
    sessionAffinity: "ClientIP",
    ports: [
      {
        name: "https",
        port: 443,
        targetPort: 443,
        protocol: "TCP",
      },
      {
        name: "inform",
        port: 8080,
        targetPort: 8080,
        protocol: "TCP",
      },
      {
        name: "stun",
        port: 3478,
        targetPort: 3478,
        protocol: "UDP",
      },
      {
        name: "discovery",
        port: 10003,
        targetPort: 10003,
        protocol: "UDP",
      },
    ],
  },
});

export { namespace as unifiNamespace, unifiDeployment, unifiService };

// Setup / Migration Instructions:
//
// 1. Deploy:
//    pulumi up
//
// 2. Verify the appliance boots (first boot runs full systemd init, give it a
//    few minutes):
//    kubectl get pods -n unifi
//    kubectl logs -n unifi -l app=unifi -f
//    kubectl get svc -n unifi   # note the EXTERNAL-IP from MetalLB
//
// 3. Access the UOS web UI:
//    https://<EXTERNAL-IP>      (UOS serves the UI on 443, no longer :8443)
//
// 4. Restore your old UniFi Network backup:
//    - Complete the UOS first-run setup.
//    - Open the Network application → Settings → System → Backups (or the
//      setup wizard) → Restore → upload your .unf backup from the old
//      controller. Wait for the restore + migration to finish.
//
// 5. (Recommended) Pin the advertised address so devices inform reliably:
//    - Uncomment the UOS_SYSTEM_IP env above and set it to the EXTERNAL-IP,
//      then `pulumi up`. (Or set the Override Inform Host in the UI to
//      http://<EXTERNAL-IP>:8080/inform.)
//
// 6. Adopt devices:
//    Network → Devices → Pending Adoption → Adopt.
//
// Why this differs from the old deployment:
// - UOS bundles MongoDB/PostgreSQL/RabbitMQ; the shared databases/mongodb.ts
//   instance and the old MONGO_* env / init Job are no longer used here.
// - The pod is privileged with a host /sys/fs/cgroup mount because UOS runs
//   systemd as PID 1.
//
// Storage:
// - UOS state:   /persistent,/data,/srv,/var/lib/unifi,/var/log (20Gi, local-path)
// - Bundled DB:  /var/lib/mongodb (10Gi, local-path)
// - Backup:      ZFS snapshots via sanoid/syncoid
//
// Ports:
// - 443/TCP:    Web UI / API (HTTPS)
// - 8080/TCP:   Device communication / inform
// - 3478/UDP:   STUN
// - 10003/UDP:  L2 device discovery
//   (enable extra ports — hotspot 8444/8880, speedtest 6789, etc. — only if used)
