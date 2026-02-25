// AdGuard Home - Network-wide ad blocking and DNS server
// Deployed as a DNS server with web interface for management
// Protected by Authentik forward auth and exposed via dns.mvissing.de
//
// Features:
// - DNS-based ad blocking and tracking prevention
// - Preconfigured with Cloudflare DNS upstream (1.1.1.1, 1.0.0.1)
// - JSON logging for Loki/Promtail integration
// - Prometheus metrics on port 3000 /metrics endpoint
// - Authentik forward auth for web interface security

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Create namespace for AdGuard Home
const namespace = new k8s.core.v1.Namespace("adguard", {
  metadata: {
    name: "adguard",
  },
});

// ConfigMap with initial AdGuard Home configuration
// Preconfigured with Cloudflare DNS and JSON logging
const adguardConfig = new k8s.core.v1.ConfigMap("adguard-config", {
  metadata: {
    name: "adguard-config",
    namespace: namespace.metadata.name,
  },
  data: {
    "AdGuardHome.yaml": `bind_host: 0.0.0.0
bind_port: 3000
beta_bind_port: 0
users: []
auth_attempts: 5
block_auth_min: 15
http_proxy: ""
language: ""
theme: auto
dns:
  bind_hosts:
    - 0.0.0.0
  port: 53
  anonymize_client_ip: false
  ratelimit: 20
  ratelimit_subnet_len_ipv4: 24
  ratelimit_subnet_len_ipv6: 56
  ratelimit_whitelist: []
  refuse_any: true
  upstream_dns:
    - https://1.1.1.1/dns-query
    - https://1.0.0.1/dns-query
  upstream_dns_file: ""
  bootstrap_dns:
    - 1.1.1.1
    - 1.0.0.1
  fallback_dns: []
  all_servers: false
  fastest_addr: false
  fastest_timeout: 1s
  allowed_clients: []
  disallowed_clients: []
  blocked_hosts:
    - version.bind
    - id.server
    - hostname.bind
  trusted_proxies:
    - 127.0.0.0/8
    - ::1/128
  cache_size: 4194304
  cache_ttl_min: 0
  cache_ttl_max: 0
  cache_optimistic: false
  bogus_nxdomain: []
  aaaa_disabled: false
  enable_dnssec: false
  edns_client_subnet:
    custom_ip: ""
    enabled: false
    use_custom: false
  max_goroutines: 300
  handle_ddr: true
  ipset: []
  ipset_file: ""
  bootstrap_prefer_ipv6: false
  upstream_timeout: 10s
  private_networks: []
  use_private_ptr_resolvers: true
  local_ptr_upstreams: []
  use_dns64: false
  dns64_prefixes: []
  serve_http3: false
  use_http3_upstreams: false
tls:
  enabled: false
  server_name: ""
  force_https: false
  port_https: 443
  port_dns_over_tls: 853
  port_dns_over_quic: 853
  port_dnscrypt: 0
  dnscrypt_config_file: ""
  allow_unencrypted_doh: false
  certificate_chain: ""
  private_key: ""
  certificate_path: ""
  private_key_path: ""
  strict_sni_check: false
querylog:
  ignored: []
  interval: 2160h
  size_memory: 1000
  enabled: true
  file_enabled: true
statistics:
  ignored: []
  interval: 24h
  enabled: true
filters:
  - enabled: true
    url: https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt
    name: AdGuard DNS filter
    id: 1
  - enabled: true
    url: https://adguardteam.github.io/HostlistsRegistry/assets/filter_2.txt
    name: AdAway Default Blocklist
    id: 2
whitelist_filters: []
user_rules: []
dhcp:
  enabled: false
  interface_name: ""
  local_domain_name: lan
  dhcpv4:
    gateway_ip: ""
    subnet_mask: ""
    range_start: ""
    range_end: ""
    lease_duration: 86400
    icmp_timeout_msec: 1000
    options: []
  dhcpv6:
    range_start: ""
    lease_duration: 86400
    ra_slaac_only: false
    ra_allow_slaac: false
clients:
  runtime_sources:
    whois: true
    arp: true
    rdns: true
    dhcp: true
    hosts: true
  persistent: []
log:
  file: ""
  max_backups: 0
  max_size: 100
  max_age: 3
  compress: false
  local_time: false
  verbose: false
os:
  group: ""
  user: ""
  rlimit_nofile: 0
schema_version: 28
`,
  },
});

// PVC for AdGuard Home configuration and data
const adguardDataPVC = new k8s.core.v1.PersistentVolumeClaim(
  "adguard-data-pvc",
  {
    metadata: {
      name: "adguard-data",
      namespace: namespace.metadata.name,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: {
        requests: {
          storage: "2Gi",
        },
      },
    },
  },
);

const adguardWorkPVC = new k8s.core.v1.PersistentVolumeClaim(
  "adguard-work-pvc",
  {
    metadata: {
      name: "adguard-work",
      namespace: namespace.metadata.name,
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

// AdGuard Home Deployment
const adguardDeployment = new k8s.apps.v1.Deployment(
  "adguard",
  {
    metadata: {
      name: "adguard",
      namespace: namespace.metadata.name,
      labels: {
        app: "adguard",
      },
    },
    spec: {
      replicas: 1,
      strategy: {
        type: "Recreate",
      },
      selector: {
        matchLabels: {
          app: "adguard",
        },
      },
      template: {
        metadata: {
          labels: {
            app: "adguard",
          },
          annotations: {
            // Prometheus scraping annotations
            "prometheus.io/scrape": "true",
            "prometheus.io/port": "9618",
            "prometheus.io/path": "/metrics",
          },
        },
        spec: {
          initContainers: [
            {
              name: "config-init",
              image: "busybox:1.37.0",
              command: ["sh", "-c"],
              args: [
                "if [ ! -f /opt/adguardhome/conf/AdGuardHome.yaml ]; then cp /tmp/config/AdGuardHome.yaml /opt/adguardhome/conf/AdGuardHome.yaml; fi",
              ],
              volumeMounts: [
                {
                  name: "data",
                  mountPath: "/opt/adguardhome/conf",
                },
                {
                  name: "config",
                  mountPath: "/tmp/config",
                },
              ],
            },
          ],
          containers: [
            {
              name: "adguard",
              image: "adguard/adguardhome:v0.107.54",
              ports: [
                {
                  containerPort: 3000,
                  name: "http",
                  protocol: "TCP",
                },
                {
                  containerPort: 53,
                  name: "dns-tcp",
                  protocol: "TCP",
                },
                {
                  containerPort: 53,
                  name: "dns-udp",
                  protocol: "UDP",
                },
                {
                  containerPort: 853,
                  name: "dns-tls",
                  protocol: "TCP",
                },
                {
                  containerPort: 784,
                  name: "dns-quic",
                  protocol: "UDP",
                },
                {
                  containerPort: 8853,
                  name: "dns-quic-alt",
                  protocol: "UDP",
                },
                {
                  containerPort: 5443,
                  name: "dnscrypt",
                  protocol: "TCP",
                },
                {
                  containerPort: 5443,
                  name: "dnscrypt-udp",
                  protocol: "UDP",
                },
              ],
              env: [
                {
                  name: "TZ",
                  value: "Europe/Berlin",
                },
              ],
              volumeMounts: [
                {
                  name: "data",
                  mountPath: "/opt/adguardhome/conf",
                },
                {
                  name: "work",
                  mountPath: "/opt/adguardhome/work",
                },
              ],
              resources: {
                requests: {
                  memory: "128Mi",
                  cpu: "100m",
                },
                limits: {
                  memory: "512Mi",
                  cpu: "1000m",
                },
              },
              livenessProbe: {
                httpGet: {
                  path: "/",
                  port: 3000,
                },
                initialDelaySeconds: 30,
                periodSeconds: 30,
              },
              readinessProbe: {
                httpGet: {
                  path: "/",
                  port: 3000,
                },
                initialDelaySeconds: 10,
                periodSeconds: 10,
              },
            },
            {
              name: "exporter",
              image: "ghcr.io/henrywhitaker3/adguard-exporter:v1.2.1",
              ports: [
                {
                  containerPort: 9618,
                  name: "metrics",
                  protocol: "TCP",
                },
              ],
              env: [
                {
                  name: "ADGUARD_SERVERS",
                  value: "http://127.0.0.1:3000",
                },
                {
                  name: "ADGUARD_USERNAMES",
                  value: "none",
                },
                {
                  name: "ADGUARD_PASSWORDS",
                  value: "none",
                },
                {
                  name: "INTERVAL",
                  value: "30s",
                },
                {
                  name: "LOG_LEVEL",
                  value: "info",
                },
              ],
              resources: {
                requests: {
                  memory: "32Mi",
                  cpu: "10m",
                },
                limits: {
                  memory: "64Mi",
                  cpu: "100m",
                },
              },
              livenessProbe: {
                httpGet: {
                  path: "/metrics",
                  port: 9618,
                },
                initialDelaySeconds: 15,
                periodSeconds: 30,
              },
            },
          ],
          volumes: [
            {
              name: "data",
              persistentVolumeClaim: {
                claimName: adguardDataPVC.metadata.name,
              },
            },
            {
              name: "work",
              persistentVolumeClaim: {
                claimName: adguardWorkPVC.metadata.name,
              },
            },
            {
              name: "config",
              configMap: {
                name: adguardConfig.metadata.name,
              },
            },
          ],
        },
      },
    },
  },
  { dependsOn: [adguardDataPVC, adguardWorkPVC, adguardConfig] },
);

// AdGuard Home Web UI Service (ClusterIP for Traefik ingress)
const adguardWebService = new k8s.core.v1.Service("adguard-web-service", {
  metadata: {
    name: "adguard-web",
    namespace: namespace.metadata.name,
    labels: {
      app: "adguard",
    },
  },
  spec: {
    type: "ClusterIP",
    selector: {
      app: "adguard",
    },
    ports: [
      {
        name: "http",
        port: 3000,
        targetPort: 3000,
        protocol: "TCP",
      },
    ],
  },
});

// AdGuard Home DNS Service (LoadBalancer for direct DNS access)
const adguardDNSService = new k8s.core.v1.Service("adguard-dns-service", {
  metadata: {
    name: "adguard-dns",
    namespace: namespace.metadata.name,
    labels: {
      app: "adguard",
    },
  },
  spec: {
    type: "LoadBalancer",
    selector: {
      app: "adguard",
    },
    ports: [
      {
        name: "dns-tcp",
        port: 53,
        targetPort: 53,
        protocol: "TCP",
      },
      {
        name: "dns-udp",
        port: 53,
        targetPort: 53,
        protocol: "UDP",
      },
      {
        name: "dns-tls",
        port: 853,
        targetPort: 853,
        protocol: "TCP",
      },
      {
        name: "dns-quic",
        port: 784,
        targetPort: 784,
        protocol: "UDP",
      },
      {
        name: "dns-quic-alt",
        port: 8853,
        targetPort: 8853,
        protocol: "UDP",
      },
      {
        name: "dnscrypt-tcp",
        port: 5443,
        targetPort: 5443,
        protocol: "TCP",
      },
      {
        name: "dnscrypt-udp",
        port: 5443,
        targetPort: 5443,
        protocol: "UDP",
      },
    ],
  },
});

// Ingress for AdGuard web interface (using Traefik)
// Protected by Authentik forward auth middleware
const adguardIngress = new k8s.networking.v1.Ingress(
  "adguard-ingress",
  {
    metadata: {
      name: "adguard",
      namespace: namespace.metadata.name,
      annotations: {
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
        "cert-manager.io/cluster-issuer": "letsencrypt-prod",
        // Protect with Authentik forward auth middleware
        "traefik.ingress.kubernetes.io/router.middlewares":
          "traefik-authentik@kubernetescrd",
        // Redirect HTTP to HTTPS
        "traefik.ingress.kubernetes.io/redirect-entry-point": "websecure",
        "traefik.ingress.kubernetes.io/redirect-permanent": "true",
        // Homepage dashboard discovery
        "gethomepage.dev/enabled": "true",
        "gethomepage.dev/name": "AdGuard Home",
        "gethomepage.dev/description": "DNS Ad Blocker",
        "gethomepage.dev/group": "Infrastructure",
        "gethomepage.dev/icon": "adguard-home",
        "gethomepage.dev/href": "https://dns.mvissing.de",
        "gethomepage.dev/pod-selector": "app=adguard",
      },
    },
    spec: {
      ingressClassName: "traefik",
      rules: [
        {
          host: "dns.mvissing.de",
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: adguardWebService.metadata.name,
                    port: {
                      number: 3000,
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
          secretName: "adguard-tls",
          hosts: ["dns.mvissing.de"],
        },
      ],
    },
  },
  { dependsOn: [adguardWebService] },
);

export {
  namespace as adguardNamespace,
  adguardDeployment,
  adguardWebService,
  adguardDNSService,
  adguardIngress,
};

// Setup Instructions:
//
// 1. Deploy AdGuard Home:
//    cd ~/Git/setup/pulumi/k8s
//    pulumi up
//
// 2. Verify deployment:
//    kubectl get pods -n adguard
//    kubectl get svc -n adguard
//    kubectl logs -n adguard -l app=adguard
//
// 3. Get the DNS LoadBalancer IP:
//    kubectl get svc -n adguard adguard-dns
//
// 4. Access the web interface:
//    URL: https://dns.mvissing.de
//    Authentication: Protected by Authentik forward auth (SSO)
//
// 5. Initial AdGuard setup:
//    - Follow the setup wizard to create admin account
//    - DNS upstream servers are already configured (Cloudflare 1.1.1.1, 1.0.0.1 via DoH)
//    - Default filter lists (AdGuard DNS filter, AdAway) are already enabled
//
// 6. Configure devices to use AdGuard DNS:
//    - Set DNS server to: <DNS-IP> (from kubectl get svc -n adguard adguard-dns)
//    - Or configure in router DHCP settings for network-wide blocking
//
// 7. Authentik Application Setup (for SSO):
//    a. Navigate to Authentik Admin UI: https://auth.mvissing.de
//    b. Applications → Applications → Create
//    c. Configure:
//       - Name: "AdGuard Home"
//       - Slug: "adguard"
//       - Provider: Select the domain-level forward auth provider
//       - Launch URL: https://dns.mvissing.de
//    d. Add to the "Kubernetes Forward Auth" outpost
//
// Monitoring:
//
// 1. Prometheus Metrics:
//    - Endpoint: http://adguard-web.adguard.svc.cluster.local:3000/control/stats
//    - Automatically scraped by Prometheus via pod annotations
//    - Metrics include: DNS queries, blocked queries, processing time, etc.
//
// 2. Logs (Loki/Promtail):
//    - AdGuard Home logs to stdout in text format
//    - Query logs stored in /opt/adguardhome/work/querylog.json (JSON format)
//    - Promtail automatically collects container logs
//    - View in Grafana via Loki data source
//
// Architecture:
// - AdGuard Home: v0.107.54 (pinned version for stability)
// - Upstream DNS: Cloudflare DoH (1.1.1.1, 1.0.0.1) - preconfigured
// - Default filters: AdGuard DNS filter, AdAway Default Blocklist
// - Web interface: Exposed via Traefik at dns.mvissing.de with TLS
// - Authentication: Authentik forward auth (domain-level SSO)
// - DNS service: LoadBalancer (MetalLB) for direct DNS access
// - Storage: local-path (ZFS-backed) for config and query logs
// - Monitoring: Prometheus metrics + Loki logs
//
// Storage:
// - Config: /opt/adguardhome/conf (2Gi PVC)
// - Work data (logs, stats): /opt/adguardhome/work (1Gi PVC)
// - Backup: ZFS snapshots via sanoid/syncoid
//
// Ports:
// - 3000/TCP: Web UI (HTTPS via Traefik at dns.mvissing.de)
// - 53/TCP+UDP: Standard DNS (via LoadBalancer)
// - 853/TCP: DNS-over-TLS (DoT)
// - 784/UDP: DNS-over-QUIC (DoQ)
// - 8853/UDP: DNS-over-QUIC alternative
// - 5443/TCP+UDP: DNSCrypt
//
// Preconfigured Settings:
// - Upstream DNS: Cloudflare DoH (1.1.1.1, 1.0.0.1)
// - Bootstrap DNS: Cloudflare (1.1.1.1, 1.0.0.1)
// - Query log: 90 days retention
// - Statistics: 24 hours interval
// - Cache size: 4MB
// - Rate limiting: 20 queries/sec per client
//
// Network Setup:
// - For network-wide blocking: Configure router DHCP to use <DNS-IP> as primary DNS
// - For specific devices: Manually set DNS to <DNS-IP>
// - Can also enable DHCP server in AdGuard (disable router DHCP first)
//
// Security:
// - Web interface protected by Authentik forward auth
// - TLS certificate from Let's Encrypt via cert-manager
// - Authentication required before accessing any AdGuard settings
// - DNS service publicly accessible (port 53) for network-wide use
//
// Upgrading AdGuard:
// - Update image version in this file (line 211)
// - Run: pulumi up
// - AdGuard automatically migrates configuration to new schema version
//
// Prometheus Metrics Available:
// - num_dns_queries: Total DNS queries processed
// - num_blocked_filtering: Queries blocked by filters
// - num_replaced_safebrowsing: Queries blocked by safe browsing
// - num_replaced_parental: Queries blocked by parental control
// - avg_processing_time: Average DNS query processing time
// - And more via /control/stats endpoint
