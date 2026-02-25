# Kubernetes Resources via Pulumi

This directory contains Pulumi definitions for Kubernetes resources running on the K3S cluster.

## Architecture

```
Raspberry Pi (pi-network) - NixOS + dnsmasq + K3S agent
├── dnsmasq (systemd)
│   ├── DHCP server (port 67)
│   └── DNS forwarder (port 53) → forwards to 127.0.0.1:5353
│
└── K3S agent
    └── AdGuard pod (hostPort 5353)
        └── DNS filtering + ad blocking

K3S VMs (k3s-node1/2/3) - Proxmox VMs
├── k3s-node1 (control plane)
├── k3s-node2 (worker)
└── k3s-node3 (worker)
```

## Files

- `adguard.ts` - AdGuard Home deployment (runs on Pi with hostPort)
- Other K8s resources go here

## Prerequisites

Before deploying:

1. **Create NFS directory on Proxmox:**
   ```bash
   ssh max@192.168.178.97
   sudo zfs create tank/k8s/adguard
   ```

2. **Ensure Pi is in K3S cluster:**
   ```bash
   kubectl get nodes
   # Should show pi-k3s
   ```

3. **Configure Pulumi:**
   ```bash
   cd /etc/nixos/pulumi/k8s
   pulumi stack init prod
   pulumi config set kubernetes:kubeconfig ~/.kube/config
   ```

## Deployment

```bash
cd /etc/nixos/pulumi/k8s

# Preview changes
pulumi preview

# Deploy
pulumi up

# Check AdGuard pod
kubectl get pods -n network-services
kubectl logs -n network-services -l app=adguard -f

# Access AdGuard UI
# Local: http://192.168.178.10:3000
# External: https://adguard.yourdomain.com (after DNS/Traefik setup)
```

## Testing DNS Flow

```bash
# From Pi (local)
dig @127.0.0.1 -p 5353 google.com  # Direct to AdGuard
dig @127.0.0.1 google.com          # Via dnsmasq → AdGuard

# From client device
dig @192.168.178.10 google.com     # Client → dnsmasq → AdGuard

# Test ad blocking
dig @192.168.178.10 doubleclick.net  # Should be blocked
```

## Architecture Notes

### Why hostPort?

AdGuard uses `hostPort: 5353` which binds the pod directly to the Pi's port 5353 on localhost. This allows:

- **Efficient local forwarding**: dnsmasq forwards to `127.0.0.1:5353` with no network overhead
- **No NodePort complexity**: Direct access via localhost
- **Pod pinned to Pi**: Must run on Pi node (intentional design)

### DNS Flow

```
Client device (192.168.178.X)
  ↓ DNS query
Pi:53 (dnsmasq)
  ↓ Forwards to 127.0.0.1:5353
Pi:5353 (AdGuard pod via hostPort)
  ↓ Filters ads, queries upstream
Internet DNS (1.1.1.1, 8.8.8.8)
  ↓ Response
AdGuard → dnsmasq → Client
```

### Multi-Architecture Cluster

The cluster has both ARM64 (Pi) and x86_64 (VMs) nodes. Workloads need to specify architecture:

```typescript
// For ARM-only (like AdGuard on Pi)
nodeSelector: {
  "kubernetes.io/hostname": "pi-k3s"
}

// For x86-only
nodeSelector: {
  "kubernetes.io/arch": "amd64"
}

// For multi-arch (most containers)
// No nodeSelector needed
```

## Troubleshooting

### AdGuard pod not starting

```bash
# Check pod status
kubectl describe pod -n network-services -l app=adguard

# Common issues:
# 1. NFS mount failed → Check /tank/k8s/adguard exists on Proxmox
# 2. Port conflict → Port 5353 already in use
# 3. Node not ready → Check Pi node: kubectl get nodes
```

### DNS not working

```bash
# Check dnsmasq on Pi
ssh max@192.168.178.10
sudo systemctl status dnsmasq
sudo journalctl -u dnsmasq -f

# Check if AdGuard is responding
dig @127.0.0.1 -p 5353 google.com

# Check from client
dig @192.168.178.10 google.com
```

### Can't access AdGuard UI

```bash
# Local access (from Pi)
curl http://localhost:3000

# External access (from network)
curl http://192.168.178.10:3000

# Via Traefik (requires ingress setup)
curl https://adguard.yourdomain.com
```

## Updates

Update AdGuard image:

```bash
# Edit adguard.ts, change image tag
# Then redeploy
pulumi up

# Or force pod recreation
kubectl rollout restart deployment/adguard -n network-services
```
