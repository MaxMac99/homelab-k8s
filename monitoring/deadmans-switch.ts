// External dead-man's switch. See docs/multi-site-migration.md, Phase 12.
//
// In-cluster alerting (Alertmanager -> ntfy, both pods in this namespace)
// cannot report the cluster being down: if the cluster is down, so are they.
// The receiver has to be a third party that keeps working when this cluster
// does not, which is why this pings healthchecks.io rather than ntfy.
//
// The CronJob's container does nothing but curl the ping URL — there is no
// health check to write. A Job only runs at all if the apiserver, scheduler,
// kubelet and CNI on some node are all working, so a *missed* ping (detected
// by healthchecks.io after its own grace period) already means as much as
// any check this code could perform, and covers failure modes a hand-rolled
// check would miss (e.g. DNS, scheduling).
//
// Deliberately no nodeSelector. Losing one node — even ionos, one of three
// etcd members — must not trip this; that is exactly what the in-cluster
// Alertmanager -> ntfy path already covers. This should only go quiet when
// nothing in the cluster can run a Job at all.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { namespaceName } from "./namespace";

const config = new pulumi.Config();
const pingUrl = config.requireSecret("deadmans-switch-ping-url");

// Kept as a Secret, matching this file's other external credentials (e.g.
// ntfyAlertCredentials in ./ntfy), even though the URL isn't especially
// sensitive — worst case for it leaking is a forged "healthy" ping, which
// needs the same in-cluster access that reading the Secret would.
const pingUrlSecret = new k8s.core.v1.Secret("deadmans-switch-ping-url", {
  metadata: {
    name: "deadmans-switch-ping-url",
    namespace: namespaceName,
  },
  stringData: {
    url: pingUrl,
  },
});

export const deadmansSwitchCronJob = new k8s.batch.v1.CronJob(
  "deadmans-switch",
  {
    metadata: {
      name: "deadmans-switch",
      namespace: namespaceName,
    },
    spec: {
      // Matches the grace period configured on the healthchecks.io check.
      schedule: "*/5 * * * *",
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: 1,
          // A hung run must not sit around eating the next schedule window —
          // Forbid above means a stuck Job silently skips every ping after it.
          activeDeadlineSeconds: 60,
          template: {
            spec: {
              restartPolicy: "Never",
              containers: [
                {
                  name: "ping",
                  image: "curlimages/curl:8.22.0",
                  command: ["/bin/sh", "-c"],
                  args: ['curl -fsS -m 10 "$(cat /etc/deadmans-switch/url)"'],
                  volumeMounts: [
                    {
                      name: "ping-url",
                      mountPath: "/etc/deadmans-switch",
                      readOnly: true,
                    },
                  ],
                  resources: {
                    requests: { cpu: "10m", memory: "16Mi" },
                    limits: { cpu: "50m", memory: "32Mi" },
                  },
                },
              ],
              volumes: [
                {
                  name: "ping-url",
                  secret: {
                    secretName: pingUrlSecret.metadata.name,
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
);

// Setup checklist:
// 1. Create a check at https://healthchecks.io — Period 5m, Grace 5m is a
//    reasonable start given the schedule above.
// 2. pulumi config set --secret deadmans-switch-ping-url https://hc-ping.com/<uuid>
// 3. pulumi up
// 4. Verify: `kubectl get cronjob,job -n monitoring -l job-name=deadmans-switch`
//    and confirm the check goes "Up" on healthchecks.io.
// 5. Simulate an outage (e.g. cordon every node, or block egress from all
//    three home/VPS uplinks) and confirm healthchecks.io alerts once the
//    grace period elapses.
