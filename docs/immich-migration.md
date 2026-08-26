# Immich migration plan

Status: **Phases A–F complete, deployed and verified 2026-08-26.** Immich runs at
`photos.mvissing.de` with an empty library, storage template and transcode policy
locked in, and Authentik OIDC wired up. ⚠️ **Remaining before any import: Max
must log in once via Authentik to create the admin account** (`isInitialized` is
still false, and the first login becomes owner). Then Phase 0's ZFS snapshots and
the Phase G pilot. Written 2026-08-22, amended the same day after the PG18
VectorChord finding collapsed the plan from three Postgres clusters to two
(§3.1). Written 2026-08-22, amended 2026-08-22 after
the PG18 VectorChord finding collapsed the plan from three Postgres clusters to
two (§3.1).

Goal, in the user's words: import all images into Immich, get rid of the
duplicates, and empty out the backup directory by moving everything to its right
place.

This document is self-contained — it carries the investigation results so a
fresh session does not need to re-derive them.

---

## 1. What is actually on disk

Investigated on maxdata 2026-08-20. Two photo trees, and **the duplicates are
mostly _between_ them, not within either one.**

### A — `/tank/daten-familie/Bilder` · 1.4 TiB · 49,401 files

| Class        | Size    | Notes                                                |
| ------------ | ------- | ---------------------------------------------------- |
| Video        | 917 GiB | ~4.6k files — two thirds of the tree                 |
| RAW          | 433 GiB | NEF 14,008 · ARW 1,708 · RAW 912 · RW2 459 · DNG 298 |
| JPG/HEIC/PNG | 71 GiB  | 26,610 JPG                                           |

Structure is `Year/Event` — `2015/Skiurlaub Gerlos`, `2010/Nordschleife`,
`2014/Geburtstag Oma`. 4,619 directories, max depth 6. **These names are real
curation and are worth preserving as albums.**

Two useful negatives:

- **Zero RAW+JPG sibling pairs**, so no false "NEF vs its JPG" duplicate storm.
- **Internal duplication is minor** — 507 groups / 550 redundant files / 13.5
  GiB, about 1% of the tree.

### B — `/tank/data/backup_old_drive` · 1.7 TiB · 263,000 files

⚠️ **This is a recovery source, not a redundant copy.** A mistake while setting
up the new `daten-familie` irreversibly deleted files; this drive is what
survived. The 622 GiB unique to it is plausibly exactly that lost material.
**Treat as read-only until Phase J passes.**

- `Aperture Library.aplibrary` — 106,471 files, 88 GiB
- `Fotos Library.photoslibrary` — 27,962 files, 92 GiB
- `Fotostream` — 3,047 files, 4.3 GiB
- Everything else — 128,567 files, ~1.5 TiB (82k JPG, 14.8k NEF, 10.5k MOV), in
  the _same_ `Year/Event` layout, with `" Kopie"` suffixes scattered through it

Cross-compared against A by (size, filename):

```
present in BOTH:   20,381 files   839 GiB
only in backup:   108,186 files   622 GiB
```

### The macOS library bundles are a trap

`.photoslibrary` and `.aplibrary` are package directories: originals _plus_
thumbnails, previews, face crops and edit derivatives. 134k files for only 180
GiB — that ratio is the giveaway. Pointed at as plain folders they would import
tens of thousands of derivative JPEGs, each a near-duplicate of a real photo,
manufacturing a review queue far larger than the original problem.

**Import only the `Masters/` subtrees. No Mac needed.**

| Bundle                        | Originals to import              | Derivatives to skip                                         |
| ----------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `Fotos Library.photoslibrary` | `Masters/` — 8,166 files, 67 GiB | `resources/` — 19,747 files, 24 GiB                         |
| `Aperture Library.aplibrary`  | `Masters/` — 6,372 files, 41 GiB | `Previews/` 10,646 (43 GiB), `Thumbnails/` 34,387 (4.6 GiB) |

= **14,538 originals / 108 GiB** out of 134,433 files / 180 GiB.

⚠️ Aperture edits (crops, adjustments) live in its database and are rendered
into `Previews/`, not `Masters/`. Importing originals only **drops them
irreversibly**. This was accepted deliberately — "just the originals".

### Space

`tank` has **7.18 TiB free**. Deduped working set ~2.1 TiB of originals, plus
thumbnails and transcodes (Immich's docs say budget 10–20% of library size),
while the ~3.1 TiB of sources still exists. Peak ≈ 5.5–6 TiB. It fits, but the
transcode policy is what keeps it from getting tight — see Phase F.

### Hetzner is not a usable backup, and not an import source

`hetzner:backup/Daten-Familie/Bilder` = 48,686 objects / 1.276 TiB against local
49,401 files / 1.391 TiB. **Not a superset.** Last written 2025-10-12, manual
(no timer, no restic/borg on maxdata — only an rclone remote and an SSH alias),
and does not cover `backup_old_drive` at all. The data loss predates it, so it
holds nothing that isn't already local. Dropped as an import source; it returns
in Phase K as an offsite _target_.

---

## 2. How Immich handles duplicates

- **Byte-identical: automatic, at upload, for photos and video alike.** The
  FAQ: _"Duplicate checking only exists for upload libraries, using the file
  hash."_ Whole-file hash, asset-type agnostic. The ~839 GiB overlap between the
  two trees is silently skipped on import. **This is also why an internal
  library was chosen over an external one** — external libraries get no hash
  dedupe at all.
- **Visually similar: ML-based, into a review queue.** "Deduplicate All"
  preselects by file size then EXIF field count. Kept assets inherit
  albums/favorites/rating/tags/description from trashed ones.
- ⚠️ **Video near-duplicate detection is unreliable.** Immich's ML runs on the
  generated _thumbnail_ — one frame for a video. Re-encodes of the same clip
  would likely be caught; two clips of the same scene would false-positive.
  Exact-hash is solid; treat visual video dedupe as advisory. (Inferred from the
  documented thumbnail behaviour, not stated for video dedupe specifically.)

---

## 3. Decisions taken

| Question     | Decision                                                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library type | **Internal**, not external — hash dedupe and real deletion both require it                                                                                                       |
| Postgres     | **Two clusters** (§3.1). VectorChord on PG18, so Immich shares the new winkel cluster with Grafana and Paperless                                                                 |
| Replication  | **Dropped.** Single instance each, plus real backups                                                                                                                             |
| Auth         | **OIDC via Authentik**, not forward auth                                                                                                                                         |
| Users        | One Authentik account per person; **all bulk import into Max's account** (hash dedupe is per-user, so splitting the import across accounts would defeat it). Max is Immich admin |
| Provisioning | Default-off, via Authentik group membership                                                                                                                                      |
| Transcoding  | Minimal during import; full pass later                                                                                                                                           |
| Backups      | `pg_dump` → `tank` now; Hetzner offsite after import                                                                                                                             |
| Alerting     | Grafana unified alerting → ntfy; existing Prometheus rules migrate there                                                                                                         |

### 3.1 Why two Postgres clusters

⚠️ **Revised 2026-08-22. This section previously argued for _three_ clusters on
the premise that VectorChord had no PostgreSQL 18 build. That premise is now
false** — it was true when the plan was written and stopped being true when
VectorChord shipped 1.0. Re-verified against ghcr on 2026-08-22:

```
tensorchord/cloudnative-vectorchord   → 18.0 … 18.4-1.1.1   (was: 17.5-0.4.3 max)
tensorchord/vchord-scratch            → pg18-v1.1.1         (CNPG image-volume format)
```

`18.4-1.1.1` matters specifically: **18.4 is the exact PG minor the existing
cluster already runs** (`ghcr.io/cloudnative-pg/postgresql:18.4`), so Immich no
longer forces a second major version onto maxdata.

Two routes existed; **the operand image was chosen** (decision 2026-08-22):

```yaml
imageName: ghcr.io/tensorchord/cloudnative-vectorchord:18.4-1.1.1
postgresql:
  shared_preload_libraries: ["vchord"]
```

The rejected alternative was CNPG 1.30's declarative image-volume extension —
`spec.postgresql.extensions[].image.reference` pointing at
`vchord-scratch:pg18-v1.1.1` over a `postgresql:18.4-system-bookworm` base. It
keeps the base image community-built, which is a real advantage on a cluster
whose other two tenants have no use for vectors, but it is a newer and much
less-travelled code path and pins two images instead of one. **If the tensorchord
operand image ever becomes a maintenance problem, that is the fallback** — the
cluster is otherwise unchanged.

⚠️ `ghcr.io/immich-app/postgres:18-vectorchord*` **is still not usable here** —
it is Immich's drop-in for docker-compose, built on the official `postgres` image
with its own entrypoint and `PGDATA` layout. It does not meet CNPG's image
contract. This is a different image from the tensorchord one above; do not
conflate them.

**Resulting layout:**

| Cluster                 | Node         | Version               | Serves                     |
| ----------------------- | ------------ | --------------------- | -------------------------- |
| `postgres` (existing)   | brink-server | PG 18.4               | authentik, homeassistant   |
| `postgres-winkel` (new) | maxdata      | PG 18.4 + VectorChord | grafana, paperless, immich |

Both clusters run the same major _and minor_ version, which is the point: one
upgrade cadence, one backup shape, and `pg_dump` portability in both directions.

⚠️ **The old §3.1 argument is preserved here because it explains a constraint
that no longer binds.** Grafana and Paperless were to run against a local
database at winkel, and could not share Immich's cluster because VectorChord was
PG17-only and `pg_dump` is forward-compatible only. With VectorChord on 18.4 both
constraints dissolve simultaneously. The locality this buys Grafana and Paperless
is still modest — `databases/postgresql.ts:203` records the cross-site path at
**p99 6.8 ms**, so the status quo was not hurting them — but it now costs one
extra cluster rather than two.

### 3.2 Why replication is being dropped

The user's reasoning, which is correct: **the concern is a site outage, and
replication does not help there** — the bulk data is single-site regardless. If
maxdata is down, Immich's photos on `tank`, Paperless's NFS media and Grafana's
`local-path` volume are all unreachable. A replicated database at Brink would
start with nothing to serve.

Replication would still have covered a disk failure with the site up. But the
databases total **135 MB** (authentik 73, paperless 32, grafana 14,
homeassistant 7.8). A nightly dump covers that, _and_ covers corruption and
accidental deletion, which replication faithfully propagates.

⚠️ **`databases/postgresql.ts:187` claims the second instance is what lets
Authentik survive maxdata. That is wrong** — `auth/authentik.ts:151,291,368`
pin all three Authentik pods to `onNode(BRINK_SERVER)`, so a Brink outage takes
Authentik down whatever its database does. **Correct this comment**, or someone
will restore the replica on the strength of it.

### 3.3 There is a live, silent replication failure

Found 2026-08-22. `postgres-1` on maxdata **has never replayed a transaction**
since it was created on 2026-08-19:

```
FATAL: could not receive data from WAL stream:
       requested WAL segment 0000000200000000000000B8 has already been removed
wal-restore: "Refusing to restore future timeline history file"
             walName=00000003.history fileTimeline=3 clusterTimeline=2
```

Retrying every 5 s since. `pg_last_xact_replay_timestamp()` is NULL. Primary at
LSN `A/A80CD4C0`, replica at `0/B80000A0` — roughly 40 GB of WAL apart. Classic
cause: primary recycled a segment before the replica fetched it, no replication
slot held it, no WAL archive to fall back on, and a past failover left the
replica on the wrong timeline.

Two things make it worse than the bug:

- **CNPG reports the cluster healthy** — `2/2 ready`, no restarts. Nothing
  surfaced it.
- **`.spec.backup` is empty.** No WAL archiving, no base backups, no PITR.

So Authentik, Paperless, Grafana and Home Assistant currently exist as exactly
one copy on one disk. **This is resolved by deletion, not repair** — Phase A4
scales to a single instance. Phase B must land first or the single-copy window
widens.

---

## 4. Phases

Phase boundaries are placed where irreversibility lives.

### Phase A — Postgres restructure

**A1.** New `postgres-winkel` Cluster in `databases/postgresql.ts`, serving
**grafana, paperless and immich** together:

- `instances: 1`, `nodeSelector: onNode(MAXDATA)`, `local-path` on
  `/fast/k8s/local-path` (458 G free, verified 2026-08-22)
- `imageName: ghcr.io/tensorchord/cloudnative-vectorchord:18.4-1.1.1` (pin
  exactly; add a Renovate regex entry). Same PG minor as the existing cluster.
- `shared_preload_libraries: ["vchord"]`
- `maintenance_work_mem` well above the current 256 MB — the vector index build
  over ~1M embeddings is the one operation that needs it
- `bootstrap.initdb.import` with `type: monolith`, databases
  `["grafana", "paperless"]`. CNPG pulls them from the live cluster over the
  network via `pg_dump`/`pg_restore`; no manual dump-and-restore, and roles come
  across with `monolith`.
- ⚠️ **Import is a point-in-time copy, not a sync.** Anything written to the old
  cluster after the import is lost. Quiesce Grafana and Paperless for the
  cutover; at 14 MB and 32 MB this is minutes.
- `immich` database + role via a `Database` CR, following the existing
  `authentik-db` / `paperless-db` pattern, with
  `extensions: [vchord, earthdistance]`. Created _after_ the import — the import
  carries only grafana and paperless.
- Password via `random.RandomPassword` + Secret with Reflector annotations to
  the `immich` namespace, exactly as `postgres-authentik` does

**Superuser: no** (decided 2026-08-22, closing the §5 open item). Immich requests
superuser by default, and the documented no-superuser path "requires manual
intervention when updating Immich" and breaks Immich's own automated backups —
the latter being irrelevant here because Phase B replaces it. The declarative
`Database.extensions` route above is what makes this work: CNPG runs
`CREATE EXTENSION` as the operator, so Immich's role never needs the privilege.

⚠️ **The collapse to two clusters is what makes this decision matter more than it
did when planned.** Immich's role now lives on the same cluster as Grafana's and
Paperless's databases, so superuser would have reached across all three. On a
dedicated cluster it would have been close to harmless.

**A2.** _(folded into A1 — there is no longer a separate `postgres-immich`
cluster. See §3.1.)_

**A3.** Repoint `monitoring/grafana.ts` and `apps/paperless.ts` at
`postgres-winkel-rw.database.svc.cluster.local`. Move their password Secrets and
Reflector annotations to the new cluster. Verify both apps work **before** A4
drops the old copies.

**A4.** ✅ **Done 2026-08-24.** Existing `postgres` Cluster → `instances: 1`, pinned to brink-server,
serving authentik and homeassistant only. Remove the grafana and paperless
`Database` CRs and managed roles. Deleting the second instance also removes
`postgres-1` and its PVC, resolving §3.3.

**A5.** ✅ **Done.** Rewrite the `instances: 2` rationale comment (§3.2). It is
wrong in two ways.

**A4/A5 outcome.** `postgres-1` and both its PVCs are gone; `postgres` is
`1/1 healthy` with `postgres-2` primary on brink-server. `enableSuperuserAccess`
is back to `false` and the `postgres-superuser` Secret no longer exists — ⚠️ note
the flip **restarts the primary** (CNPG: "Primary instance is being restarted
without a switchover"), which took ~150 s. Authentik was unaffected: 0 restarts,
`/-/health/ready/` returns 200, 5 live connections, 3 users intact.

⚠️ **The old `grafana` and `paperless` databases still exist on the Brink
cluster**, retained deliberately as the rollback for the A2 import. Their roles
are no longer CNPG-managed but still exist in PostgreSQL, so the copies remain
usable. Delete them only once you are confident in the Winkel cluster — nothing
does it automatically, and `databaseReclaimPolicy: retain` is what preserved
them.

✅ **Gate passed 2026-08-24.** `postgres-winkel` is healthy on maxdata at PG
18.4; grafana and paperless row counts match the source exactly
(`dashboard` 5/5, `data_source` 3/3, `documents_document` 730/730,
`documents_correspondent` 40/40, `auth_user` 5/5); both apps hold live
connections to `postgres-winkel-rw` and none to the old cluster; Grafana's
`/api/health` reports `"database": "ok"`.

⚠️ **The plan's extension list was incomplete and the first apply failed on it.**
`extensions: [vchord, earthdistance]` is not sufficient — CNPG issues a plain
`CREATE EXTENSION`, never `CASCADE`, so every dependency must be named
explicitly and in order. VectorChord is built on pgvector and supplies no type of
its own, so `vchord` failed with `required extension "vector" is not installed`;
`earthdistance` likewise needs `cube`. The working list is
**`[vector, vchord, cube, earthdistance]`**. All four ship in the tensorchord
image; they only needed declaring. Installed now: vchord 1.1.1, vector 0.8.3.

**Gate (original wording):** authentik, homeassistant, grafana, paperless all
healthy on their new homes; empty `immich` database reachable with `vchord`
present
(`SELECT extversion FROM pg_extension WHERE extname='vchord';`).

⚠️ **The old warning here — "A1 and A2 both put a cluster on maxdata's
`local-path`, at different major versions" — no longer applies.** There is one
new cluster, at the same major _and_ minor version as the existing one. Keep the
`Cluster` names distinct enough that a stray `kubectl` can't hit the wrong one.

### Phase B — Backups to `tank`

⚠️ **Sequence B before A4** unless you accept a wider single-copy window — A4 is
what deletes the (already useless) replica, and until B lands there is no second
copy of anything.

CronJob in the `database` namespace: `pg_dump -Fc` per database → NFS PVC backed
by `/tank/k8s/nfs/pg-backups` on `tank`. Nightly, ~14 days retention, across
**both** clusters. Sanoid already snapshots `tank`, so the dumps inherit snapshot
history for free.

✅ **Done, 2026-08-22 — and with _no_ `setup`-repo change at all.**

⚠️ **This deliberately does not follow the "new dataset" wording above.** The
target is a plain directory, `/tank/k8s/nfs/pg-backups`, created once on maxdata
(`mkdir` + `chown 26:26`) and served by the `/tank/k8s/nfs` export that already
exists. A dataset was implemented and then reverted; the reasoning is worth
keeping, because the plan's wording will otherwise invite someone to "fix" this.

What a dataset would have bought here: essentially only a quota. Snapshots come
from sanoid's `tank/k8s` entry, which is already `recursive = true`; compression
is already `lz4`, and `pg_dump -Fc` is compressed before it lands. Retention
(14 days, pruned nightly) already bounds growth.

What it would have cost:

- It could not live at `tank/k8s/nfs/pg-backups`, because **`/tank/k8s/nfs` is a
  plain directory inside `tank/k8s`, not a dataset** — `paperless-media`,
  `homeassistant`, `mosquitto` and `matter-server` are all directories in it. So
  `zfs create -p` there would have created `tank/k8s/nfs` as a dataset and
  shadowed all four. It would have had to be `tank/k8s/pg-backups`, a sibling of
  `timemachine`.
- That needs a `fileSystems` entry, because `mountpoint=legacy` is inherited and
  `hardware-configuration.nix` records that a legacy dataset without one "never
  mounts, it just loses to a directory of the same name" — the 689 GB Time
  Machine incident.
- Which needs a guard against exactly that, whose only safe failure mode was
  stopping `nfs-server` — taking Paperless's media and Time Machine down over a
  `pg_dump` problem.

⚠️ **The shadowing hazard is created by choosing a dataset, not solved by it.** A
directory cannot fail to mount. This also matches the host's existing convention:
every other NFS-backed app is a plain directory under `/tank/k8s/nfs`.

If a quota is ever genuinely wanted, shorten the retention window first.

✅ **Deployed and verified 2026-08-24.** First run took **8 s** for all five
databases and every dump is readable by `pg_restore`:

| database      | dump        | TOC entries            |
| ------------- | ----------- | ---------------------- |
| authentik     | 9,233,588 B | 1,656                  |
| paperless     | 3,784,396 B | 736                    |
| grafana       | 302,327 B   | 667                    |
| immich        | 2,622 B     | 8 (empty, as expected) |
| homeassistant | 905 B       | **0**                  |

⚠️ **`homeassistant` is empty, and the plan's "homeassistant 7.8 MB" was a
misreading.** 7,814 kB is exactly the size of an untouched PostgreSQL database on
this cluster — `postgres` and `app` are the same size — and the database has
**zero tables**. Home Assistant's recorder is not writing to PostgreSQL despite
`apps/homeassistant.ts` opening with "Uses shared PostgreSQL database for
recorder"; it is presumably still on SQLite. So the estate's real database
footprint is authentik + grafana + paperless, and **Home Assistant's history is
not covered by these backups** — it lives in a `local-path` volume at Brink. That
is a separate gap, not one Phase B closes.

⚠️ Immich's database will be much larger than 135 MB — vectors for ~170k assets,
plausibly 5–20 GB. Re-check dump duration once populated.

### Phase C — Alerting moves to Grafana

✅ **Done 2026-08-25.** Grafana unified alerting delivers to ntfy; the estate has
one alerting system rather than two.

**C1 — inventory.** Five rules existed, all in `monitoring/prometheus.ts`:
`CertificateExpiringSoon`, `CertificateNotReady`, `PublicIngressDown`,
`ZfsPoolNotOnline`, `ZfsVdevErrors`.

**C2 — provisioned.** `monitoring/grafana.ts` now provisions `contactpoints.yaml`,
`policies.yaml` and `rules.yaml`. Four traps, each of which cost a failed render
or a crash loop:

- The chart pipes the whole `alerting` tree through Helm's `tpl`, so a literal
  `{{ $labels.namespace }}` is evaluated as a _Helm_ template and the render
  dies with `undefined variable "$labels"`. `escapeHelm()` wraps them.
- Provisioning files take a bare `$NTFY_PASSWORD`; `$__env{...}` is
  **grafana.ini's** syntax and is not interchangeable. The wrong one sends the
  literal string and fails 401 at delivery time only.
- `envRenderSecret`, not `env` — the chart renders `env` into a plain ConfigMap.
- ntfy's `grafana` template is a **different built-in** from the `alertmanager`
  one; payload shapes differ and mixing them fails outright.
- ⚠️ The Prometheus datasource now pins `uid: prometheus`. Rules reference a
  datasource by uid, and an unpinned one gets a name-derived hash. **Changing a
  provisioned datasource's uid crash-loops Grafana** with
  `Datasource provisioning error: data source not found` until the old
  datasource is deleted — a one-time migration, not needed on a fresh cluster.

**C3 — Prometheus rules removed, and Alertmanager _stays_**, closing that open
item. Its job is now exactly one rule, `GrafanaAlertingDown`:

> Grafana's unified alerting keeps rules, evaluation state and notification
> history in Grafana's own database — `postgres-winkel` on maxdata. So Grafana
> cannot alert on Grafana being down, nor reliably on its own database being
> down. Left alone that is circular: `PostgresBackupStale`, the alert _about_ the
> databases, would be hosted by something that needs a database to run.
> Prometheus and Alertmanager have no such dependency.

⚠️ **This is not redundancy against losing maxdata** — Prometheus, Alertmanager,
Grafana and ntfy all run there. `monitoring/deadmans-switch.ts` covers that case
and is deliberately unpinned.

**C4 — `PostgresBackupStale`.** Reads the timestamp `databases/backup.ts` pushes
to the Pushgateway from a container that only runs if the dump succeeded. Alerts
if any database's last successful dump is >36 h old.

⚠️ **It alerts on _no data_, unlike every other rule.** For the ported rules an
absent series means the thing is not deployed; here it means no backup has ever
succeeded, or the Pushgateway lost state. A missing backup must never be
indistinguishable from a healthy one — that is the exact silence the broken
replica hid behind for three days.

⚠️ **The Pushgateway was not actually enabled by config.** `prometheus.ts` said
`pushgateway: { enabled: false }`, but the subchart is keyed
`prometheus-pushgateway`; Helm ignored the unknown key and it ran on its own
default for 12 days. Same trap already documented for `prometheus-node-exporter`.
It is now explicitly `enabled: true`, because this alert depends on it.

**Verification.** All six Grafana rules report `health: ok` against live data, and
a temporary always-firing probe rule delivered through the _stored_ contact point
— ntfy logged `Received message` from Grafana's pod IP as user `alertmanager`.
The probe was then deleted.

⚠️ **Not verified: that each ported rule fires on its real condition.** That would
mean expiring a certificate, taking the public ingress down and degrading a ZFS
pool. What was checked is that each evaluates without error against real data and
that the delivery path works.

### Phase D — `apps/immich.ts`

✅ **Done 2026-08-26.** Chart `0.12.0` (appVersion `v2.6.3`) from
`oci://ghcr.io/immich-app/immich-charts/immich`, four pods on maxdata, TLS
issued, `photos.mvissing.de` on the **internal** Traefik.

**Verified in the running system**, not inferred: Immich created 62 tables in
`postgres-winkel`, and `face_index` and `clip_index` are both built on the
`vchordrq` access method — VectorChord is genuinely doing the vector work, which
is the entire justification for §3.1.

**Pre-checks passed.** maxdata is a Ryzen 5 3600X reporting `x86-64-v3`, above
the `x86-64-v2` floor for the ML container. Alpine DNS resolves internal and
external names from a pod there, so the search-domain bug does not apply.

Corrections to the plan's Phase D wording, all found by rendering the chart:

- The cache is **Valkey, not Redis**, and it is `enabled: false` by default.
  Immich does not start without it.
- ⚠️ **The chart's shared `controllers.main` block does not reach a controller
  with any other name.** `server.controllers.workers` inherits nothing — not the
  image, not the database, not Redis. The image gap fails the render loudly; the
  env gap would have been silent, producing a worker that cannot reach Postgres.
  Both server controllers therefore carry the full env.
- The worker split via a second controller **is** supported and is safe: the
  `immich-server` Service selects on `controller: main` **and** `name: server`,
  so API traffic never reaches the workers pod.
- Database is wired with `DB_HOSTNAME`/`DB_USERNAME`/`DB_PASSWORD` rather than
  `DB_URL`. ⚠️ `DB_URL` would embed the password literally in chart values, and
  a secret value inside a `helm.v3` chart cannot be rotated — see Phase C.
- ML model cache and the Valkey queue are real PVCs rather than the chart's
  default `emptyDir`, as the chart's own comments recommend. Losing the job
  queue part-way through a multi-day import is not a small thing.

⚠️ **The first deploy put every pod on brink-server.** The reasoning that the
volumes would force placement was wrong twice over: the library is NFS _served
by_ maxdata, so photo I/O crossed the WireGuard overlay at WAN latency; and
`local-path`'s `nodePathMap` lists brink-server too, so the ML cache and Valkey
queue were provisioned there. **local-path stamps nodeAffinity onto a PV at
first bind, so the wrong node on the first schedule is permanent** — the fix
required deleting both PVCs, not just rescheduling. Now pinned with a top-level
`defaultPodOptions.nodeSelector` (verified to reach all four Deployments).

⚠️ It must be a **node** pin, not `winkelSite`: winkel-pi is arm64 and Immich
publishes no arm64 machine-learning image.

⚠️ **`pulumi refresh` was needed** after deleting those PVCs with `kubectl` —
Pulumi still believed they existed and would not recreate them, which surfaced
as the Helm release timing out with pods Pending.

### Phase E — Authentik OIDC

✅ **Done 2026-08-26**, created through Authentik's REST API and wired into
`apps/immich.ts`.

| Object          | Value                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| OAuth2 provider | `Immich` (pk 7), confidential, `sub_mode: hashed_user_id`, `issuer_mode: per_provider` |
| Application     | slug `immich`, launch `https://photos.mvissing.de`                                     |
| Group           | `immich-users` (Max is the only member)                                                |
| Policy binding  | `immich-users` → the application                                                       |
| Scope mapping   | `immich_role` — `admin` for members of `admins`, else `user`                           |

Flows and signing key copied from the existing Grafana/Paperless providers so all
four match. Redirect URIs: `/auth/login`, `/user-settings`, and
`app.immich:///oauth-callback` for mobile.

⚠️ **`immich_role` is a custom scope and had to be requested explicitly.** The
default scope list is `openid email profile`; without adding it the claim is
simply absent and everyone silently becomes a regular user. Verified through the
application's discovery document, which lists `immich_role` in
`scopes_supported`, and from inside the Immich pod — which reaches
`https://auth.mvissing.de/application/o/immich/` and gets the right issuer back.

⚠️ **The provider is not captured by this repo.** This estate has no Authentik
blueprints; Grafana and Paperless work the same way. Only the client credentials
live in the stack config, so an Authentik rebuild means recreating all of this by
hand.

⚠️ The config now renders to a **Secret**, not the chart's default ConfigMap
(`configurationKind: "Secret"`) — the OIDC client secret is part of it.

⚠️ **Local password login stays enabled**, deliberately, until an OIDC login has
actually been observed to work.

⚠️ **Found on the way:** the `authentikApiToken` in the stack config had not
existed in Authentik's database since the 2026-08-07 rebuild — Authentik held
exactly one token, the outpost's. **Homepage's Authentik widget had therefore
been silently dead for ~19 days**, showing nothing rather than erroring.
Replacing the token fixed both that and this phase.

**Outstanding, and it is a browser action:** Immich reports
`isInitialized: false`, meaning no account exists yet. ⚠️ **The first user to log
in becomes the owner/admin**, so Max must log in via Authentik _before_ anyone
else is added to `immich-users`.

### Phase F — Configure before importing a single file

Changing any of these later means a storage-migration job over 2 TB of spinning
disk.

✅ **The chart can do this declaratively.** `immich.configuration` is
`immich-config.json` as YAML, so the storage template and transcode policy can
live in `apps/immich.ts` rather than being clicked through the UI. That was not
known when this plan was written and is worth taking — it makes the template
reviewable and reproducible. Note it makes the UI's config read-only.

⚠️ The Handlebars braces below would be evaluated by Helm's `tpl` if passed
through chart values — the same trap that broke Grafana's alerting provisioning
in Phase C. Escape them, or use a separate ConfigMap plus
`immich.existingConfiguration`.

**Storage template** — requested layout `yyyy/album/MM-dd/model/filename`:

```
{{y}}/{{#if album}}{{{album}}}{{else}}Other{{/if}}/{{MM}}-{{dd}}/{{#if model}}{{{model}}}{{else}}Unknown{{/if}}/{{{filename}}}
```

Giving `2015/Skiurlaub Gerlos/02-14/NIKON D300/DSC_4135.NEF`.

- ⚠️ **Triple braces throughout.** `{{album}}` HTML-escapes — `DRK u. NetGo`
  and umlauts get mangled otherwise.
- ⚠️ `{{#if}}` fallbacks are **not optional**. Scans, downloads and WhatsApp
  images have no `model`; without the guard you get empty path segments.
- ⚠️ **Multi-album assets resolve `{{album}}` to the most recently created
  one.** This interacts with dedupe: resolving a duplicate merges the trashed
  asset's albums into the keeper, so a deduped file can move folder. Not data
  loss, but the layout is not perfectly stable.
- Filename collisions are safe — a sequence number is appended, nothing is
  overwritten.

**Why the template matters more than aesthetics:** by default Immich writes
files under random UUIDs. For a library that is partly the only surviving copy,
losing Postgres would leave 2 TB of unidentifiable files. With the template on,
the library stays salvageable without Immich.

**Transcode policy: minimal**, before any import. ~15k video files, 917 GiB in
`Bilder` alone plus 10.5k MOV in the backup, CPU-only — no GPU on any node.
The default policy transcodes anything not already in the target format and
could run for weeks while producing hundreds of GiB.

⚠️ **Still outstanding:** create the accounts and confirm Max is admin. That is
UI work and gated on Phase E, and it is the last thing before Phase 0's
snapshots and the Phase G pilot.

⚠️ `ffmpeg.transcode` is `disabled`, not merely reduced — default is `required`.
Videos in unsupported codecs will not play in a browser until Phase K flips it,
which is now a `pulumi up` rather than a UI toggle.

### Phase G — Pilot import

Import **one year only** (e.g. `2015/`). Measure upload throughput, thumbnail
rate, ML embedding rate, transcode rate. Extrapolate before committing.

This step is not optional. Total is **~170k assets** across all three sources
with CPU-only ML; whether the full pass is 2 days or 3 weeks on maxdata is
genuinely unknown, and finding out here is far cheaper than finding out halfway
through.

**Phase 0 — take ZFS snapshots of `tank/daten-familie` and `tank/data` before
this phase.** Instant, near-zero space, and it makes every later local operation
reversible. Nothing before Phase G touches photo data.

### Phase H — Full import

Order matters: the first import of a given file wins, and hash dedupe silently
drops later identical copies. So the curated tree goes first.

1. `/tank/daten-familie/Bilder` — `--album` per event folder
2. `/tank/data/backup_old_drive`, **excluding the two bundles** — ~839 GiB
   auto-skipped, ~622 GiB lands as new
3. The two `Masters/` trees — 14,538 files, 108 GiB

Exclude `.DS_Store`, `.aae`, `.scr` throughout. **Run the CLI on maxdata** so it
reads locally rather than over NFS. `--dry-run` first on each.

### Phase I — Dedupe review

Wait for ML jobs to drain, then work the duplicates utility. Byte-identical
duplicates never appear here — they were rejected at upload. This queue is only
the visually-similar ones.

### Phase J — Reconciliation gate

Script it: hash every source file, pull every asset checksum from the Immich
API, prove each source file is either present or was skipped as a known
duplicate. Anything unaccounted for gets investigated, not assumed.

**Nothing is deleted until this passes.** `backup_old_drive` is the only
surviving copy of some of this material.

### Phase K — Reclaim and offsite

1. Hetzner offsite working and **verified by a test restore** — for the Immich
   library _and_ its Postgres. Metadata (albums, faces, dedupe decisions) lives
   only in the database; losing it loses all of that even if every file
   survives.
2. Then delete `backup_old_drive`.
3. Destroy the Phase 0 snapshots **last**.
4. Optionally re-run `Transcode Video / All` now that nothing competes with it.

⚠️ 2 TB to a Hetzner **Storage Box** is SFTP/WebDAV — a different product from
Hetzner Object Storage, so CNPG's native S3 backup does not apply. rclone, as
Phase B.

---

## 5. Open items

- ~~**Superuser vs not** for Immich's database role (Phase A1).~~ **Closed
  2026-08-22: no superuser**, via declarative `Database.extensions`. See Phase A1.
- ~~**Whether Alertmanager stays** once the rules move to Grafana (Phase C3).~~
  **Closed 2026-08-25: it stays**, running exactly one rule — the watchdog on
  Grafana itself. See Phase C3.
- ~~**A PG18 vchord extension image** in CNPG image-volume format.~~ **Closed
  2026-08-22: found, and better than expected.** Both a PG18 image-volume
  extension (`vchord-scratch:pg18-v1.1.1`) _and_ a full PG18.4 operand image
  (`cloudnative-vectorchord:18.4-1.1.1`) now exist. The estate is two clusters,
  not three. See §3.1.
- ~~The **Prometheus alert inventory** was never captured.~~ **Closed
  2026-08-25**, captured from source in C1: five rules, all listed above.
