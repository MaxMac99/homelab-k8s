// Mosquitto - MQTT Broker for Home Assistant
// Lightweight MQTT broker for IoT device communication
// Used by Home Assistant for MQTT integrations (Zigbee2MQTT, sensors, etc.)

import * as k8s from "@pulumi/kubernetes";

import { homeassistantNamespace } from "./homeassistant";

// ConfigMap with Mosquitto configuration
const mosquittoConfig = new k8s.core.v1.ConfigMap("mosquitto-config", {
  metadata: {
    name: "mosquitto-config",
    namespace: homeassistantNamespace.metadata.name,
  },
  data: {
    "mosquitto.conf": `listener 1883
allow_anonymous false
password_file /mosquitto/data/password.txt
persistence true
persistence_location /mosquitto/data/
log_dest stdout
`,
  },
});

// NFS Persistent Volume for Mosquitto data
const mosquittoDataPV = new k8s.core.v1.PersistentVolume("mosquitto-data-pv", {
  metadata: {
    name: "mosquitto-data",
  },
  spec: {
    capacity: {
      storage: "1Gi",
    },
    accessModes: ["ReadWriteMany"],
    persistentVolumeReclaimPolicy: "Retain",
    storageClassName: "nfs",
    mountOptions: ["nfsvers=4.2", "hard", "intr"],
    nfs: {
      server: "192.168.178.2",
      path: "/tank/k8s/nfs/mosquitto",
    },
  },
});

// PVC for Mosquitto data
const mosquittoDataPVC = new k8s.core.v1.PersistentVolumeClaim(
  "mosquitto-data-pvc",
  {
    metadata: {
      name: "mosquitto-data",
      namespace: homeassistantNamespace.metadata.name,
    },
    spec: {
      accessModes: ["ReadWriteMany"],
      storageClassName: "nfs",
      volumeName: mosquittoDataPV.metadata.name,
      resources: {
        requests: {
          storage: "1Gi",
        },
      },
    },
  },
);

// Mosquitto Deployment
const mosquittoDeployment = new k8s.apps.v1.Deployment("mosquitto", {
  metadata: {
    name: "mosquitto",
    namespace: homeassistantNamespace.metadata.name,
    labels: {
      app: "mosquitto",
    },
  },
  spec: {
    replicas: 1,
    strategy: {
      type: "Recreate",
    },
    selector: {
      matchLabels: {
        app: "mosquitto",
      },
    },
    template: {
      metadata: {
        labels: {
          app: "mosquitto",
        },
      },
      spec: {
        containers: [
          {
            name: "mosquitto",
            image: "eclipse-mosquitto:2.0.21",
            ports: [
              {
                containerPort: 1883,
                name: "mqtt",
                protocol: "TCP",
              },
            ],
            volumeMounts: [
              {
                name: "config",
                mountPath: "/mosquitto/config/mosquitto.conf",
                subPath: "mosquitto.conf",
                readOnly: true,
              },
              {
                name: "data",
                mountPath: "/mosquitto/data",
              },
            ],
            resources: {
              requests: {
                memory: "32Mi",
                cpu: "50m",
              },
              limits: {
                memory: "128Mi",
                cpu: "200m",
              },
            },
            livenessProbe: {
              tcpSocket: {
                port: 1883,
              },
              initialDelaySeconds: 10,
              periodSeconds: 30,
              timeoutSeconds: 5,
            },
            readinessProbe: {
              tcpSocket: {
                port: 1883,
              },
              initialDelaySeconds: 5,
              periodSeconds: 10,
              timeoutSeconds: 5,
            },
          },
        ],
        volumes: [
          {
            name: "config",
            configMap: {
              name: mosquittoConfig.metadata.name,
            },
          },
          {
            name: "data",
            persistentVolumeClaim: {
              claimName: mosquittoDataPVC.metadata.name,
            },
          },
        ],
      },
    },
  },
  },
  { dependsOn: [mosquittoDataPVC] },
);

// Mosquitto Service
const mosquittoService = new k8s.core.v1.Service("mosquitto-service", {
  metadata: {
    name: "mosquitto",
    namespace: homeassistantNamespace.metadata.name,
  },
  spec: {
    type: "ClusterIP",
    selector: {
      app: "mosquitto",
    },
    ports: [
      {
        port: 1883,
        targetPort: 1883,
        name: "mqtt",
        protocol: "TCP",
      },
    ],
  },
});

export { mosquittoDeployment, mosquittoService };

// Setup Instructions:
//
// 1. Create Mosquitto data directory on NFS server:
//    sudo mkdir -p /tank/k8s/nfs/mosquitto
//    sudo chown -R 1000:1000 /tank/k8s/nfs/mosquitto
//
// 2. Deploy with: pulumi up
//
// 3. Create MQTT user credentials (exec into the pod):
//    kubectl exec -n homeassistant deploy/mosquitto -- \
//      mosquitto_passwd -c /mosquitto/data/password.txt homeassistant
//    (enter password when prompted, then copy the file to config mount)
//
//    Or create the password file on the NFS share before deploying:
//    docker run --rm -v /tank/k8s/nfs/mosquitto:/data eclipse-mosquitto:2.0.21 \
//      mosquitto_passwd -c /data/password.txt homeassistant
//
// 4. Add MQTT integration in Home Assistant:
//    - Settings → Devices & Services → Add Integration
//    - Search: "MQTT"
//    - Broker: mosquitto.homeassistant.svc.cluster.local
//    - Port: 1883
//    - Username: homeassistant
//    - Password: (password from step 3)