import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Time Machine service for macOS backups - Multi-user setup
// Uses mbentley/timemachine which provides SMB with Avahi service discovery
// Supports multiple users (max, michael, anna) sharing 3TB storage

// User passwords (stored as Pulumi config secrets)
// Set with: pulumi config set --secret maxPassword "your-password"
const config = new pulumi.Config();
const maxPassword = config.requireSecret("maxPassword");
const michaelPassword = config.requireSecret("michaelPassword");
const annaPassword = config.requireSecret("annaPassword");

// ConfigMap with user configurations
// Each user gets their own .conf file with credentials and settings
const timemachineUsersConfig = new k8s.core.v1.ConfigMap("timemachine-users", {
    metadata: {
        name: "timemachine-users",
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
        mountOptions: ["nolock", "nfsvers=4.1"],  // nolock to avoid rpc-statd requirement
        nfs: {
            server: "192.168.178.2",  // maxdata
            path: "/tank/k8s/timemachine",
        },
    },
});

// PersistentVolumeClaim
const timemachinePVC = new k8s.core.v1.PersistentVolumeClaim("timemachine-pvc", {
    metadata: {
        name: "timemachine-pvc",
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
});

// Time Machine Deployment
const timemachineDeployment = new k8s.apps.v1.Deployment("timemachine", {
    metadata: {
        name: "timemachine",
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
                hostNetwork: true,  // Required for Avahi mDNS advertisement
                nodeSelector: {
                    // Run on x86_64 nodes (not on Pi)
                    "kubernetes.io/arch": "amd64",
                },
                containers: [{
                    name: "timemachine",
                    image: "mbentley/timemachine:smb",
                    env: [
                        {
                            name: "ADVERTISED_HOSTNAME",
                            value: "192.168.178.12",  // Use IP instead of hostname for mDNS
                        },
                        {
                            name: "CUSTOM_SMB_CONF",
                            value: "false",
                        },
                        {
                            name: "EXTERNAL_CONF",
                            value: "/users",  // Enable multi-user mode
                        },
                        {
                            name: "HIDE_SHARES",
                            value: "no",
                        },
                        {
                            name: "MIMIC_MODEL",
                            value: "TimeCapsule8,119",  // Mimic Time Capsule for better compatibility
                        },
                        {
                            name: "VOLUME_SIZE_LIMIT",
                            value: "0",  // Use ZFS quota instead (3TB total)
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
                            mountPath: "/opt",  // Mount at /opt so user dirs (/opt/max, /opt/michael, /opt/anna) are on NFS
                        },
                        {
                            name: "users-config",
                            mountPath: "/users",
                        },
                    ],
                    securityContext: {
                        privileged: true,  // Required for SMB
                    },
                }],
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
        annotations: {
            "metallb.universe.tf/loadBalancerIPs": "192.168.178.12",  // Using IP from MetalLB pool (11-19)
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

export const timemachineIP = timemachineService.status.loadBalancer.ingress[0].ip;
export const timemachineName = "TimeMachine";
