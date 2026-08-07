// Mosquitto - MQTT Broker for Home Assistant
// Lightweight MQTT broker for IoT device communication
// Used by Home Assistant for MQTT integrations (Zigbee2MQTT, sensors, etc.)

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import { homeassistantNamespace } from "./homeassistant";
import { lb, onNode, BRINK_SERVER } from "../infrastructure/sites";

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

// MQTT credentials, generated rather than hand-made.
//
// ⚠️ `allow_anonymous false` with a `password_file` that does not exist means
// Mosquitto starts happily and refuses every connection — it does not fail, it
// just rejects. On a clean volume there is no password file, so one has to be
// created before the broker is useful. Previously that was a manual
// `mosquitto_passwd` run documented in a comment, which is exactly the kind of
// step that is forgotten on a rebuild.
const mosquittoPassword = new random.RandomPassword("mosquitto-password", {
  length: 32,
  special: false, // keep it safe to pass through a shell in the init container
});

const mosquittoSecret = new k8s.core.v1.Secret("mosquitto-credentials", {
  metadata: {
    name: "mosquitto-credentials",
    namespace: homeassistantNamespace.metadata.name,
  },
  stringData: {
    username: "homeassistant",
    password: mosquittoPassword.result,
  },
});

// PVC for Mosquitto data — local-path on brink-server.
//
// Was an NFS PV on maxdata at /tank/k8s/nfs/mosquitto. Mosquitto moved to
// Brink with Home Assistant (8.2): the two talk constantly, and every MQTT
// message would otherwise cross the WAN overlay to reach a broker at the other
// site. The retained data is a password file and a small persistence store.
//
// ReadWriteOnce, not ReadWriteMany — local-path cannot do RWX, and with
// `strategy: Recreate` below there is never more than one writer anyway.
const mosquittoDataPVC = new k8s.core.v1.PersistentVolumeClaim(
  "mosquitto-data-pvc",
  {
    metadata: {
      name: "mosquitto-data",
      namespace: homeassistantNamespace.metadata.name,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: {
        requests: {
          storage: "1Gi",
        },
      },
    },
  },
);

// Mosquitto Deployment
const mosquittoDeployment = new k8s.apps.v1.Deployment(
  "mosquitto",
  {
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
          // Pinned to brink-server: its local-path volume lives on that node's
          // NVMe and has no replica anywhere (D6).
          nodeSelector: onNode(BRINK_SERVER),
          // Write the password file before the broker starts.
          //
          // `-c` recreates it every start, which is deliberate: the file is
          // then a pure function of the Secret, so it cannot drift and a lost
          // volume self-heals. Runs as uid 1883 (mosquitto) so the broker can
          // read what it writes — local-path creates the directory 0777, so
          // the non-root write succeeds.
          initContainers: [
            {
              name: "init-passwd",
              image: "eclipse-mosquitto:2.0.22",
              securityContext: { runAsUser: 1883, runAsGroup: 1883 },
              command: [
                "sh",
                "-c",
                'mosquitto_passwd -c -b /mosquitto/data/password.txt "$MQTT_USER" "$MQTT_PASS"',
              ],
              env: [
                {
                  name: "MQTT_USER",
                  valueFrom: {
                    secretKeyRef: {
                      name: mosquittoSecret.metadata.name,
                      key: "username",
                    },
                  },
                },
                {
                  name: "MQTT_PASS",
                  valueFrom: {
                    secretKeyRef: {
                      name: mosquittoSecret.metadata.name,
                      key: "password",
                    },
                  },
                },
              ],
              volumeMounts: [{ name: "data", mountPath: "/mosquitto/data" }],
            },
          ],
          containers: [
            {
              name: "mosquitto",
              image: "eclipse-mosquitto:2.0.22",
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
    annotations: {
      // Moved from 192.168.178.15 to Brink's pool, with the broker. Every
      // device configured against the old address must be repointed.
      "metallb.universe.tf/loadBalancerIPs": lb.mosquitto,
    },
  },
  spec: {
    type: "LoadBalancer",
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

// The generated MQTT credentials, for configuring Home Assistant's MQTT
// integration. Read with:
//   kubectl get secret mosquitto-credentials -n homeassistant \
//     -o jsonpath='{.data.password}' | base64 -d
export const mosquittoUsername = "homeassistant";
export const mosquittoPasswordValue = pulumi.secret(mosquittoPassword.result);
