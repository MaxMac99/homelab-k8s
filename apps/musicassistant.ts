// Music Assistant — media library manager and multi-room audio server.
//
// ⚠️ This is NOT a Home Assistant add-on, and cannot be. Add-ons need the
// Supervisor, which only exists under Home Assistant OS / Supervised; this
// estate runs the plain container (`homeassistant.ts`), so the add-on store is
// absent by construction. Music Assistant therefore runs as its own workload
// and Home Assistant talks to it over the network, via the Music Assistant
// integration — Settings → Devices & Services → Add Integration.
//
// ⚠️ Upstream explicitly does not support Kubernetes: "The docker install must
// be a simple standalone container (e.g. not using kubernetes)". `hostNetwork`
// below is functionally what their `network_mode: host` requirement asks for,
// so this is expected to work — but a support request will be declined, and
// that is the trade accepted here.
//
// See https://music-assistant.io/installation/

import * as k8s from "@pulumi/kubernetes";
import { activeClusterIssuer } from "../infrastructure/cert-manager";
import { onNode, BRINK_SERVER } from "../infrastructure/sites";

const namespace = new k8s.core.v1.Namespace("musicassistant", {
  metadata: {
    name: "musicassistant",
  },
});

// Library, cache and settings. local-path on brink-server.
//
// ReadWriteOnce and `strategy: Recreate` below, for the same reason as Home
// Assistant: local-path cannot do RWX and this is a single writer with an
// embedded database.
const musicassistantDataPVC = new k8s.core.v1.PersistentVolumeClaim(
  "musicassistant-data-pvc",
  {
    metadata: {
      name: "musicassistant-data",
      namespace: namespace.metadata.name,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: {
        requests: {
          // Metadata, artwork and the library database. No local music files —
          // there is no music library on `tank`, so sources are the streaming
          // providers configured in the UI.
          storage: "10Gi",
        },
      },
    },
  },
);

const musicassistantDeployment = new k8s.apps.v1.Deployment(
  "musicassistant",
  {
    metadata: {
      name: "musicassistant",
      namespace: namespace.metadata.name,
      labels: {
        app: "musicassistant",
      },
    },
    spec: {
      replicas: 1,
      strategy: {
        // Single writer on an RWO volume, like Home Assistant.
        type: "Recreate",
      },
      selector: {
        matchLabels: {
          app: "musicassistant",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "musicassistant",
          },
        },
        spec: {
          // ⚠️ hostNetwork is a hard requirement, not a convenience.
          //
          // Music Assistant discovers players over mDNS/uPnP, which is
          // multicast and does not traverse a Service. Worse, AirPlay,
          // Chromecast, DLNA and Sonos open *random* TCP/UDP ports in both
          // directions — so there is no set of containerPorts that would make
          // a bridged pod work. Upstream states host networking (or macvlan)
          // is mandatory.
          hostNetwork: true,
          dnsPolicy: "ClusterFirstWithHostNet",
          // Pinned to brink-server, and the reason is the same as Home
          // Assistant's: with hostNetwork the node *is* the discovery domain.
          // Every player is at Brink, so anywhere else and it would be
          // listening on a segment with no speakers on it. It also holds the
          // local-path volume.
          nodeSelector: onNode(BRINK_SERVER),
          containers: [
            {
              name: "musicassistant",
              image: "ghcr.io/music-assistant/server:2.9.13",
              ports: [
                {
                  // Web UI and API. Informational under hostNetwork, but kept
                  // so the Service and Ingress below have a named target.
                  containerPort: 8095,
                  name: "http",
                  protocol: "TCP",
                },
                {
                  // Audio stream server. ⚠️ Players fetch audio from *this*
                  // port over the LAN, so it must be reachable from the Brink
                  // segment or playback fails while the UI looks healthy.
                  // brink-server's firewall trusts eno1 for exactly this
                  // reason — see hosts/nixos/brink-server/default.nix.
                  containerPort: 8097,
                  name: "stream",
                  protocol: "TCP",
                },
              ],
              env: [
                {
                  name: "TZ",
                  value: "Europe/Berlin",
                },
                {
                  name: "LOG_LEVEL",
                  value: "info",
                },
              ],
              volumeMounts: [
                {
                  name: "data",
                  mountPath: "/data",
                },
              ],
              resources: {
                requests: {
                  // Upstream states a 2 GB minimum and recommends 4 GB+ where
                  // the host runs anything else. brink-server also runs Home
                  // Assistant, matter-server, mosquitto and a k3s server, so
                  // the limit is set at the recommended figure rather than the
                  // minimum.
                  memory: "1Gi",
                  cpu: "500m",
                },
                limits: {
                  memory: "4Gi",
                  cpu: "2000m",
                },
              },
              livenessProbe: {
                httpGet: {
                  path: "/",
                  port: 8095,
                },
                initialDelaySeconds: 90,
                periodSeconds: 30,
                timeoutSeconds: 10,
                failureThreshold: 5,
              },
              readinessProbe: {
                httpGet: {
                  path: "/",
                  port: 8095,
                },
                initialDelaySeconds: 30,
                periodSeconds: 10,
                timeoutSeconds: 5,
                failureThreshold: 10,
              },
            },
          ],
          volumes: [
            {
              name: "data",
              persistentVolumeClaim: {
                claimName: musicassistantDataPVC.metadata.name,
              },
            },
          ],
        },
      },
    },
  },
  { dependsOn: [musicassistantDataPVC] },
);

// ClusterIP for the Ingress to target.
//
// ⚠️ As with Home Assistant, the endpoint behind this is the *node* address,
// not a pod IP, because the pod runs hostNetwork. This Service carries the UI
// only — the stream port is deliberately absent, because players reach it
// directly on the LAN and routing it through the cluster would put Traefik in
// the path of every audio stream.
const musicassistantService = new k8s.core.v1.Service(
  "musicassistant-service",
  {
    metadata: {
      name: "musicassistant",
      namespace: namespace.metadata.name,
    },
    spec: {
      type: "ClusterIP",
      selector: {
        app: "musicassistant",
      },
      ports: [
        {
          port: 80,
          targetPort: 8095,
          name: "http",
          protocol: "TCP",
        },
      ],
    },
  },
);

const musicassistantIngress = new k8s.networking.v1.Ingress(
  "musicassistant-ingress",
  {
    metadata: {
      name: "musicassistant",
      namespace: namespace.metadata.name,
      annotations: {
        // An Ingress is a declaration; do not block the deploy on a controller
        // reconciling it. Same reasoning as homeassistant.ts.
        "pulumi.com/skipAwait": "true",
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
        "cert-manager.io/cluster-issuer": activeClusterIssuer,

        "traefik.ingress.kubernetes.io/redirect-entry-point": "websecure",
        "traefik.ingress.kubernetes.io/redirect-permanent": "true",

        // Homepage dashboard discovery
        "gethomepage.dev/enabled": "true",
        "gethomepage.dev/name": "Music Assistant",
        "gethomepage.dev/description": "Multi-room Audio",
        "gethomepage.dev/group": "Home",
        "gethomepage.dev/icon": "music-assistant",
        "gethomepage.dev/pod-selector": "app=musicassistant",
        "gethomepage.dev/href": "https://music.mvissing.de",
      },
    },
    spec: {
      // The internal class. Nothing here is published to the internet.
      ingressClassName: "traefik",
      rules: [
        {
          host: "music.mvissing.de",
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: musicassistantService.metadata.name,
                    port: {
                      number: 80,
                    },
                  },
                },
              },
            ],
          },
        },
      ],
      tls: [
        {
          secretName: "musicassistant-tls",
          hosts: ["music.mvissing.de"],
        },
      ],
    },
  },
);

export {
  namespace as musicassistantNamespace,
  musicassistantDeployment,
  musicassistantService,
  musicassistantIngress,
};

// Setup:
//
// 1. brink-server must trust its LAN interface before playback will work.
//    `networking.firewall.trustedInterfaces = ["eno1"]` in the `setup` repo.
//    Without it the UI still loads through the Ingress and players are still
//    discovered over mDNS — but every stream fails, because the player cannot
//    reach the stream server on 8097. ⚠️ That failure looks like a broken
//    player, not a firewall.
//
// 2. pulumi up
//
// 3. Open https://music.mvissing.de and complete first-run authentication.
//    https://music-assistant.io/first-run/
//
// 4. Add music sources — none are configured initially. Settings → Music
//    Providers. There is no local library on `tank`, so these are streaming
//    providers (Spotify, Tidal, YouTube Music, …). If a local library is ever
//    added, bind-mount it read-only at /media rather than letting Music
//    Assistant mount the share itself: in-container mounting needs SYS_ADMIN,
//    DAC_READ_SEARCH and apparmor:unconfined, which is a large privilege
//    increase for a container on the same node as Home Assistant.
//
// 5. Connect Home Assistant: Settings → Devices & Services → Add Integration →
//    Music Assistant. Point it at the *node* address, not the Ingress:
//      http://192.168.1.2:8095
//    ⚠️ Using https://music.mvissing.de here would put Traefik and a WAN hop in
//    the path of the websocket for no benefit — both run on brink-server.
//
// 6. Players (AirPlay, Chromecast, DLNA, Sonos) are discovered automatically
//    once they are on the Brink segment. Home Assistant media players are
//    available via the Home Assistant player provider.
//
// Notes:
// - Web UI / API: 8095. Audio stream server: 8097 (next port up if occupied).
// - Music Assistant and every player must share one L2 segment — this is why
//   it is pinned to brink-server and why nothing at Winkel can use it.
// - Upstream does not support Kubernetes installs; see the header.
