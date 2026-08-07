// Site topology and address plan.
//
// Mirrors `modules/data/network-config.nix` in the `setup` repo, which is the
// authority for anything a NixOS host also consumes. Values duplicated here are
// the ones Kubernetes needs and NixOS cannot hand us: pool ranges, LoadBalancer
// pins, and the labels used to place workloads.
//
// ⚠️ Two of these values are also hardcoded outside this repo. Changing them
// here alone breaks things silently:
//   - `lb.loki`        → hosts/nixos/maxdata/monitoring.nix (Alloy ships logs
//                        to it; a stale value stops log shipping with no error)
//   - `site.*.ingressVIP` → AdGuard's split-horizon rewrites at both sites, and
//                        ionos's DNAT rules until Phase 9 removes them
//
// See docs/multi-site-migration.md, Phase 8.

/** Node label carrying the site. Set by NixOS via k3s flags, not by Pulumi. */
export const ZONE_LABEL = "topology.kubernetes.io/zone";

/** Node label carrying the CPU architecture. `winkel-pi` is the only arm64 node. */
export const ARCH_LABEL = "kubernetes.io/arch";

/** Node label carrying the hostname, for pinning to one specific machine. */
export const HOSTNAME_LABEL = "kubernetes.io/hostname";

/**
 * Sites, keyed by the literal value of `topology.kubernetes.io/zone`.
 *
 * `public` (ionos) has no LAN and therefore no MetalLB pool — L2 mode needs a
 * shared segment and a VPS has nobody to ARP with. It is also tainted
 * `edge=true:NoSchedule`, so nothing lands there without a toleration.
 */
export const sites = {
  brink: {
    zone: "brink",
    /** UDM SE. DHCP is .6-.199, so the pool sits clear of it. */
    pool: "192.168.1.240-192.168.1.250",
    ingressVIP: "192.168.1.240",
  },
  winkel: {
    zone: "winkel",
    /** FritzBox. DHCP is .20-.200, so the pool sits clear of it. */
    pool: "192.168.178.240-192.168.178.250",
    ingressVIP: "192.168.178.240",
  },
} as const;

/**
 * Pinned LoadBalancer addresses.
 *
 * Every LoadBalancer service is pinned. Nothing may rely on MetalLB's
 * allocation order: the old cluster's Traefik held 192.168.178.10 by
 * first-come luck from a .10-.20 pool, which a rebuild does not reproduce.
 *
 * The old .10-.15 assignments are all dead — that pool no longer exists.
 */
export const lb = {
  /** Winkel's site-local Traefik. Must equal sites.winkel.ingressVIP. */
  traefikWinkel: sites.winkel.ingressVIP,
  /** Brink's site-local Traefik. Must equal sites.brink.ingressVIP. */
  traefikBrink: sites.brink.ingressVIP,
  /** Loki, for log shippers on bare metal. ⚠️ Also in maxdata's Alloy config. */
  loki: "192.168.178.241",
  /** Time Machine. ⚠️ Also baked into ADVERTISED_HOSTNAME in its own container. */
  timemachine: "192.168.178.242",
  /** UniFi controller. Was unpinned and drifted on every rebuild. */
  unifi: "192.168.178.243",
  /** Mosquitto. Moved to Brink with Home Assistant — the devices are there. */
  mosquitto: "192.168.1.241",
} as const;

/** Schedule onto any node at Winkel (maxdata or winkel-pi). */
export const winkelSite = { [ZONE_LABEL]: sites.winkel.zone };

/** Schedule onto any node at Brink (brink-server only, today). */
export const brinkSite = { [ZONE_LABEL]: sites.brink.zone };

/**
 * Pin to one specific node.
 *
 * ⚠️ Every `local-path` volume is genuinely node-local and there is no
 * cross-site replication, by design (D6). A pod that moves node loses its
 * data, so anything holding a local-path PVC pins to a *node*, not a site.
 */
export const onNode = (hostname: string) => ({ [HOSTNAME_LABEL]: hostname });

/** The node with the ZFS pools, NFS and Samba. Winkel. */
export const MAXDATA = "maxdata";

/** Brink's only always-on machine. Also that site's DNS and subnet router. */
export const BRINK_SERVER = "brink-server";

/** Raspberry Pi 4 at Winkel. The only arm64 node, and a k3s agent. */
export const WINKEL_PI = "winkel-pi";
