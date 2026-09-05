// Nightly logical backups of every application database to `tank`.
//
// See docs/immich-migration.md Phase B.
//
// ⚠️ **This is the first real backup any of these databases has ever had.**
// Until this landed, `.spec.backup` was empty on the only cluster — no WAL
// archiving, no base backups, no PITR — and the one replica that existed had
// never replayed a transaction since it was created (§3.3). Authentik,
// Paperless, Grafana and Home Assistant were a single copy on a single disk
// while CNPG reported the cluster healthy.
//
// Why `pg_dump` rather than CNPG's own backup, or replication:
//
//   - Replication was dropped estate-wide. The risk being managed is a site
//     outage, and a replica does not help there — the bulk data (Immich's
//     photos, Paperless's media, Grafana's volume) is single-site regardless.
//     It also faithfully propagates corruption and accidental deletion, which
//     are at least as likely here as a disk failure.
//   - CNPG's native backup targets S3-compatible object storage. The offsite
//     target for this estate is a Hetzner *Storage Box*, which is SFTP/WebDAV
//     and a different product from Hetzner Object Storage, so that path does
//     not apply. Phase K adds rclone on top of what this writes.
//
// The whole estate is ~135 MB today, so a nightly full dump is cheap.
// ⚠️ That stops being true once Immich is populated — vectors for ~170k assets,
// plausibly 5–20 GB. Re-check the duration and the retention window then.
//
// ---------------------------------------------------------------------------
// Storage: a plain directory on `tank`, and deliberately *not* a ZFS dataset.
//
// `/tank/k8s/nfs/pg-backups`, created once on maxdata (`mkdir` + `chown 26:26`)
// and served by the `/tank/k8s/nfs` export that already exists. It needs **no
// NixOS change at all**, which is the point.
//
// ⚠️ The plan (Phase B) specifies a *dataset*, and this deliberately does not
// follow it. A dataset was built and then reverted, because on this host it buys
// almost nothing and costs a lot:
//
//   - Snapshots come from sanoid's `tank/k8s` entry, which is `recursive = true`.
//     A plain directory inside it inherits 48 hourly / 30 daily / 6 monthly
//     either way.
//   - Compression is `lz4` on `tank/k8s` already, and `pg_dump -Fc` output is
//     compressed before it reaches the disk, so this barely registers.
//   - The only real gain was a quota — and retention (below) already bounds
//     growth, with the prune running every night.
//
// Against that, a dataset there would have to be `tank/k8s/pg-backups`: a
// sibling of `timemachine`, because `/tank/k8s/nfs` is itself only a directory
// (`paperless-media`, `homeassistant`, `mosquitto` and `matter-server` all live
// in it as directories), so `zfs create -p` at the planned path would have minted
// `tank/k8s/nfs` as a dataset and shadowed all four. That in turn needs a
// `fileSystems` entry — `mountpoint=legacy` is inherited, and
// hardware-configuration.nix records that a legacy dataset without one "never
// mounts, it just loses to a directory of the same name" — plus a guard against
// exactly that, whose only safe failure mode was stopping nfs-server and taking
// Paperless and Time Machine down with it.
//
// ⚠️ So the shadowing hazard that motivates all of that is *created* by choosing
// a dataset, not solved by it. A directory cannot fail to mount. If a quota is
// ever genuinely wanted, shorten RETENTION_DAYS first.
//
// This follows the host's own convention: every other NFS-backed app here is a
// plain directory under `/tank/k8s/nfs`.
// ---------------------------------------------------------------------------

import * as k8s from "@pulumi/kubernetes";
import { HOSTNAME_LABEL, MAXDATA } from "../infrastructure/sites";
import {
  postgresqlNamespace,
  postgresqlHost,
  postgresWinkelHost,
} from "./postgresql";

/** How many days of dumps to keep on `tank`. */
const RETENTION_DAYS = 14;

/**
 * Every database that must be backed up, and how to reach it.
 *
 * ⚠️ Each database is dumped **as its own owner**, using the same Secret its
 * application already uses. This is the reason no superuser credential appears
 * anywhere in this file: a role can always `pg_dump` a database it owns, and
 * every database here is owned by exactly one per-app role.
 *
 * The cost of that choice is that role definitions themselves are not dumped —
 * `pg_dumpall --globals-only` does need superuser. That is fine and deliberate:
 * the roles are declared in `postgresql.ts` and their passwords are generated
 * by Pulumi, so they are already reproducible from this repo plus the stack's
 * encrypted config. A restore recreates the cluster from Pulumi first, then
 * loads data from these dumps.
 *
 * ⚠️ Adding a database here is not automatic. A new application with its own
 * database is invisible to this job until it is added to this list.
 */
const backupTargets = [
  { db: "authentik", host: postgresqlHost, secret: "postgres-authentik" },
  {
    db: "homeassistant",
    host: postgresqlHost,
    secret: "postgres-homeassistant",
  },
  { db: "grafana", host: postgresWinkelHost, secret: "postgres-grafana" },
  { db: "paperless", host: postgresWinkelHost, secret: "postgres-paperless" },
  { db: "immich", host: postgresWinkelHost, secret: "postgres-immich" },
];

// Static NFS bind for the dump target.
//
// ⚠️ `storageClassName: "pg-backups"` names no real StorageClass, and that is
// correct — `kubectl get sc` lists only `local-path`. For a *static* bind the
// class name is only a matching key between PV and PVC; `volumeName` on the
// claim does the binding and no provisioner is involved. Paperless media does
// the same under `nfs` and Time Machine under `nfs-storage`. Do not "fix" this
// by adding an NFS provisioner.
//
// ⚠️ What *does* hang is a PVC that omits `storageClassName` entirely, because
// there is no default StorageClass in this cluster. The two failures look alike
// and are not the same.
const backupPV = new k8s.core.v1.PersistentVolume("postgres-backup-pv", {
  metadata: {
    name: "postgres-backups",
  },
  spec: {
    capacity: {
      storage: "500Gi",
    },
    accessModes: ["ReadWriteMany"],
    // ⚠️ `Retain`, so that destroying this PV never takes the dumps with it.
    persistentVolumeReclaimPolicy: "Retain",
    storageClassName: "pg-backups",
    mountOptions: ["nfsvers=4.2", "hard", "intr"],
    nfs: {
      server: "192.168.178.2", // maxdata
      path: "/tank/k8s/nfs/pg-backups",
    },
  },
});

const backupPVC = new k8s.core.v1.PersistentVolumeClaim("postgres-backup-pvc", {
  metadata: {
    name: "postgres-backups",
    namespace: postgresqlNamespace,
  },
  spec: {
    accessModes: ["ReadWriteMany"],
    storageClassName: "pg-backups",
    volumeName: backupPV.metadata.name,
    resources: {
      requests: {
        storage: "500Gi",
      },
    },
  },
});

/** Where each target's credentials are mounted inside the dump container. */
const secretMountPath = (db: string) => `/etc/pg-secrets/${db}`;

// The dump script.
//
// Runs every target, and deliberately does *not* abort on the first failure —
// one unreachable cluster must not cost us the dumps from the other. The exit
// status is non-zero if any target failed, so the Job still goes Failed and
// the per-database success metric below simply is not written for the ones
// that did not make it.
const dumpScript = `
set -uo pipefail

ts="$(date -u +%Y%m%dT%H%M%SZ)"
failed=0
: > /metrics/backups.prom

echo "# HELP postgres_backup_last_success_timestamp_seconds Unix time of the last successful pg_dump." >> /metrics/backups.prom
echo "# TYPE postgres_backup_last_success_timestamp_seconds gauge" >> /metrics/backups.prom
echo "# HELP postgres_backup_size_bytes Size of the last successful pg_dump, in bytes." >> /metrics/backups.prom
echo "# TYPE postgres_backup_size_bytes gauge" >> /metrics/backups.prom

dump_one() {
  db="$1"
  host="$2"
  dir="/backups/$db"
  out="$dir/$db-$ts.dump"

  mkdir -p "$dir"

  PGPASSWORD="$(cat "/etc/pg-secrets/$db/password")"
  export PGPASSWORD
  user="$(cat "/etc/pg-secrets/$db/username")"

  echo "==> $db on $host"

  # -Fc (custom format) rather than plain SQL: it is compressed, and
  # pg_restore can then be selective about what it replays.
  #
  # Written to .partial first and renamed on success, so a dump interrupted
  # halfway can never be mistaken for a complete one by the retention sweep
  # or by a future restore.
  if pg_dump -h "$host" -U "$user" -d "$db" -Fc --no-owner --no-acl \\
       -f "$out.partial" 2>&1; then
    mv "$out.partial" "$out"
    size="$(stat -c %s "$out")"
    echo "    ok: $size bytes"
    echo "postgres_backup_last_success_timestamp_seconds{database=\\"$db\\"} $(date +%s)" >> /metrics/backups.prom
    echo "postgres_backup_size_bytes{database=\\"$db\\"} $size" >> /metrics/backups.prom
  else
    echo "    FAILED"
    rm -f "$out.partial"
    failed=1
  fi

  unset PGPASSWORD
}

${backupTargets.map((t) => `dump_one ${t.db} ${t.host}`).join("\n")}

# Retention sweep. Runs regardless of whether any dump failed above — a failing
# database must not cause unbounded growth from the ones that still work.
#
# ⚠️ Deletes only completed dumps (*.dump). Stale *.partial files from an
# interrupted run are cleaned separately and more aggressively.
echo "==> pruning dumps older than ${RETENTION_DAYS} days"
find /backups -type f -name '*.dump' -mtime +${RETENTION_DAYS} -print -delete || true
find /backups -type f -name '*.partial' -mtime +1 -print -delete || true

echo "==> on disk now:"
du -sh /backups/* 2>/dev/null || true
df -h /backups

exit "$failed"
`;

// Pushing the completion timestamp is a *separate container* for a mundane
// reason: the CNPG operand image ships no curl and no wget (verified — only
// pg_dump, find, date, gzip). Rather than layer a custom image for one HTTP
// POST, the dump runs as an initContainer and the push as the main container.
//
// ⚠️ This ordering is load-bearing, not incidental. An initContainer that fails
// means the main container never starts, so a failed backup pushes *no*
// timestamp at all — which is precisely what makes the Phase C "backup age"
// alert able to catch it. Collapsing these into one container with `;` between
// them would report success for a backup that did not happen.
const pushScript = `
set -euo pipefail
curl -fsS --data-binary @/metrics/backups.prom \\
  http://prometheus-prometheus-pushgateway.monitoring.svc.cluster.local:9091/metrics/job/postgres-backup
echo "pushed:"
cat /metrics/backups.prom
`;

export const postgresBackupCronJob = new k8s.batch.v1.CronJob(
  "postgres-backup",
  {
    metadata: {
      name: "postgres-backup",
      namespace: postgresqlNamespace,
    },
    spec: {
      // 02:30 Europe/Berlin-ish. Deliberately clear of Sanoid's hourly snapshot
      // on the hour, so a dump is not being written while `tank` is snapshotted
      // mid-file.
      schedule: "30 2 * * *",
      timeZone: "Europe/Berlin",
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
      // Keep a failed run visible rather than retrying into the same failure
      // all night; the next schedule is only 24 h away and the alert covers it.
      jobTemplate: {
        spec: {
          backoffLimit: 1,
          activeDeadlineSeconds: 3600,
          template: {
            spec: {
              restartPolicy: "Never",
              // ⚠️ Must agree with the `chown 26:26` applied once to
              // `/tank/k8s/nfs/pg-backups` on maxdata. 26 is the uid
              // CloudNativePG's operand image runs as, which is what the
              // existing cluster pods already use.
              //
              // `fsGroup` is set for the emptyDir the two containers share, but
              // it does *not* fix the NFS mount — the kubelet deliberately
              // skips recursive chown on NFS volumes. Ownership there is the
              // NixOS side's job, and nothing checks the two agree; the symptom
              // if they drift is `pg_dump: could not open output file:
              // Permission denied`.
              securityContext: {
                runAsUser: 26,
                runAsGroup: 26,
                fsGroup: 26,
                runAsNonRoot: true,
              },
              // Pinned to maxdata: it *is* the NFS server, so the dumps are
              // written over loopback rather than across the WireGuard overlay.
              // The Brink databases are small and the connection is a stream,
              // so pulling them cross-site costs far less than pushing the
              // resulting files would.
              nodeSelector: { [HOSTNAME_LABEL]: MAXDATA },
              initContainers: [
                {
                  name: "dump",
                  // Same operand image as the Brink cluster, so pg_dump's major
                  // version matches the servers it dumps. ⚠️ pg_dump is
                  // forward-compatible only — an older pg_dump cannot read a
                  // newer server, which is why this must not lag behind either
                  // cluster's `imageName`.
                  image: "ghcr.io/cloudnative-pg/postgresql:18.6",
                  command: ["/bin/bash", "-c"],
                  args: [dumpScript],
                  volumeMounts: [
                    { name: "backups", mountPath: "/backups" },
                    { name: "metrics", mountPath: "/metrics" },
                    ...backupTargets.map((t) => ({
                      name: `secret-${t.db}`,
                      mountPath: secretMountPath(t.db),
                      readOnly: true,
                    })),
                  ],
                  resources: {
                    requests: { cpu: "100m", memory: "256Mi" },
                    limits: { cpu: "2", memory: "1Gi" },
                  },
                },
              ],
              containers: [
                {
                  name: "push-metrics",
                  image: "curlimages/curl:8.22.0",
                  command: ["/bin/sh", "-c"],
                  args: [pushScript],
                  volumeMounts: [
                    { name: "metrics", mountPath: "/metrics", readOnly: true },
                  ],
                  resources: {
                    requests: { cpu: "10m", memory: "16Mi" },
                    limits: { cpu: "50m", memory: "64Mi" },
                  },
                },
              ],
              volumes: [
                {
                  name: "backups",
                  persistentVolumeClaim: {
                    claimName: backupPVC.metadata.name,
                  },
                },
                { name: "metrics", emptyDir: {} },
                ...backupTargets.map((t) => ({
                  name: `secret-${t.db}`,
                  secret: { secretName: t.secret },
                })),
              ],
            },
          },
        },
      },
    },
  },
);

export { backupPV, backupPVC };

// Restoring one database:
//
//   1. Find the dump:
//      kubectl -n database exec deploy/... -- ls -la /backups/<db>
//      (or on maxdata directly: ls -la /tank/k8s/pg-backups/<db>)
//
//   2. Stop the application, so nothing writes while the restore runs.
//
//   3. pg_restore, as the owning role:
//      pg_restore -h <cluster>-rw.database.svc.cluster.local -U <db> -d <db> \
//                 --clean --if-exists --no-owner --no-acl <file>.dump
//
// ⚠️ The dumps carry no roles and no ACLs (--no-owner --no-acl above). The
// cluster and its roles are recreated from Pulumi first; these files are data
// only. A restore into an empty cluster therefore means `pulumi up` and *then*
// pg_restore, not pg_restore alone.
//
// ⚠️ Never tested is never a backup. Phase K gates on a real restore, and the
// offsite copy gates on the same thing.
