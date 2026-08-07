import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { lb, onNode, MAXDATA } from "../infrastructure/sites";

// Time Machine service for macOS backups - Multi-user setup
// Uses mbentley/timemachine which provides SMB with Avahi service discovery
// Supports multiple users (max, michael, anna) sharing 3TB storage

// User passwords (stored as Pulumi config secrets)
// Set with: pulumi config set --secret maxPassword "your-password"
const config = new pulumi.Config();
const maxPassword = config.requireSecret("maxPassword");
const michaelPassword = config.requireSecret("michaelPassword");
const annaPassword = config.requireSecret("annaPassword");

// Own namespace, like every other app.
//
// Everything here previously omitted metadata.namespace entirely and so landed
// in `default` — including the SMB credentials for three people. Nothing
// scoped to this app could be selected, quota'd or deleted without touching
// whatever else `default` accumulated.
const namespace = new k8s.core.v1.Namespace("timemachine", {
  metadata: { name: "timemachine" },
});

// ConfigMap with user configurations
// Each user gets their own .conf file with credentials and settings
const timemachineUsersConfig = new k8s.core.v1.ConfigMap("timemachine-users", {
  metadata: {
    name: "timemachine-users",
    namespace: namespace.metadata.name,
  },
  data: {
    "max.conf": pulumi.interpolate`TM_USERNAME=max
TM_GROUPNAME=timemachine
PASSWORD="${maxPassword}"
SHARE_NAME=TimeMachine-Max
TM_UID=1000
TM_GID=1000
VOLUME_SIZE_LIMIT=2000000000000`,
    "michael.conf": pulumi.interpolate`TM_USERNAME=michael
TM_GROUPNAME=timemachine
PASSWORD="${michaelPassword}"
SHARE_NAME=TimeMachine-Michael
TM_UID=1001
TM_GID=1000
VOLUME_SIZE_LIMIT=2000000000000`,
    "anna.conf": pulumi.interpolate`TM_USERNAME=anna
TM_GROUPNAME=timemachine
PASSWORD="${annaPassword}"
SHARE_NAME=TimeMachine-Anna
TM_UID=1002
TM_GID=1000
VOLUME_SIZE_LIMIT=2000000000000`,
  },
});

// PersistentVolume for Time Machine data (NFS backed by ZFS)
const timemachinePV = new k8s.core.v1.PersistentVolume("timemachine-pv", {
  metadata: {
    name: "timemachine-pv",
  },
  spec: {
    capacity: {
      storage: "3Ti",
    },
    accessModes: ["ReadWriteMany"],
    persistentVolumeReclaimPolicy: "Retain",
    storageClassName: "nfs-storage",
    mountOptions: ["nolock", "nfsvers=4.1"], // nolock to avoid rpc-statd requirement
    nfs: {
      server: "192.168.178.2", // maxdata
      path: "/tank/k8s/timemachine",
    },
  },
});

// PersistentVolumeClaim
const timemachinePVC = new k8s.core.v1.PersistentVolumeClaim(
  "timemachine-pvc",
  {
    metadata: {
      name: "timemachine-pvc",
      namespace: namespace.metadata.name,
    },
    spec: {
      accessModes: ["ReadWriteMany"],
      storageClassName: "nfs-storage",
      resources: {
        requests: {
          storage: "3Ti",
        },
      },
      volumeName: timemachinePV.metadata.name,
    },
  },
);

// Time Machine Deployment
const timemachineDeployment = new k8s.apps.v1.Deployment("timemachine", {
  metadata: {
    name: "timemachine",
    namespace: namespace.metadata.name,
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        app: "timemachine",
      },
    },
    template: {
      metadata: {
        labels: {
          app: "timemachine",
        },
      },
      spec: {
        hostNetwork: true, // Required for Avahi mDNS advertisement
        // Pinned to maxdata, not merely to amd64.
        //
        // "amd64" now matches brink-server and ionos too. Landing at Brink
        // would mount 3 Ti of NFS across the WAN overlay, and — because this
        // is hostNetwork for Avahi — advertise mDNS onto Brink's segment while
        // the Service announces a Winkel address. The backups, the NFS export
        // and the LoadBalancer address are all at Winkel; the pod belongs
        // there too.
        nodeSelector: onNode(MAXDATA),
        containers: [
          {
            name: "timemachine",
            image: "mbentley/timemachine:smb",
            env: [
              {
                // ⚠️ Must equal the Service's pinned address below. This is
                // what Avahi advertises to Macs, so a mismatch does not fail
                // loudly — Time Machine simply advertises a destination that
                // does not answer, and backups stop being offered.
                name: "ADVERTISED_HOSTNAME",
                value: lb.timemachine, // Use IP instead of hostname for mDNS
              },
              {
                name: "CUSTOM_SMB_CONF",
                value: "false",
              },
              {
                name: "EXTERNAL_CONF",
                value: "/users", // Enable multi-user mode
              },
              {
                name: "HIDE_SHARES",
                value: "no",
              },
              {
                name: "MIMIC_MODEL",
                value: "TimeCapsule8,119", // Mimic Time Capsule for better compatibility
              },
              {
                name: "VOLUME_SIZE_LIMIT",
                value: "0", // Use ZFS quota instead (3TB total)
              },
              {
                name: "WORKGROUP",
                value: "WORKGROUP",
              },
              {
                name: "SMB_NFS_ACES",
                value: "yes",
              },
              {
                name: "SMB_METADATA",
                value: "stream",
              },
              {
                name: "SMB_PORT",
                value: "445",
              },
              {
                name: "SMB_VFS_OBJECTS",
                value: "acl_xattr fruit streams_xattr",
              },
            ],
            ports: [
              {
                name: "smb",
                containerPort: 445,
                protocol: "TCP",
              },
              {
                name: "netbios-ns",
                containerPort: 137,
                protocol: "UDP",
              },
              {
                name: "netbios-dgm",
                containerPort: 138,
                protocol: "UDP",
              },
              {
                name: "netbios-ssn",
                containerPort: 139,
                protocol: "TCP",
              },
            ],
            volumeMounts: [
              {
                name: "timemachine-data",
                mountPath: "/opt", // Mount at /opt so user dirs (/opt/max, /opt/michael, /opt/anna) are on NFS
              },
              {
                name: "users-config",
                mountPath: "/users",
              },
            ],
            securityContext: {
              privileged: true, // Required for SMB
            },
          },
        ],
        volumes: [
          {
            name: "timemachine-data",
            persistentVolumeClaim: {
              claimName: timemachinePVC.metadata.name,
            },
          },
          {
            name: "users-config",
            configMap: {
              name: timemachineUsersConfig.metadata.name,
            },
          },
        ],
      },
    },
  },
});

// Service for Time Machine (LoadBalancer to expose on network)
const timemachineService = new k8s.core.v1.Service("timemachine", {
  metadata: {
    name: "timemachine",
    namespace: namespace.metadata.name,
    annotations: {
      // Paired with ADVERTISED_HOSTNAME above — change both or neither.
      "metallb.universe.tf/loadBalancerIPs": lb.timemachine,
    },
  },
  spec: {
    type: "LoadBalancer",
    selector: {
      app: "timemachine",
    },
    ports: [
      {
        name: "smb",
        port: 445,
        targetPort: 445,
        protocol: "TCP",
      },
      {
        name: "netbios-ns",
        port: 137,
        targetPort: 137,
        protocol: "UDP",
      },
      {
        name: "netbios-dgm",
        port: 138,
        targetPort: 138,
        protocol: "UDP",
      },
      {
        name: "netbios-ssn",
        port: 139,
        targetPort: 139,
        protocol: "TCP",
      },
    ],
    sessionAffinity: "ClientIP",
  },
});

export const timemachineIP =
  timemachineService.status.loadBalancer.ingress[0].ip;
export const timemachineName = "TimeMachine";
