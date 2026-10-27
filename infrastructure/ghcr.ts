// Pull secrets for MaxMac99's private GHCR packages (trip, meals).
//
// One classic PAT with `read:packages` covers every package the account owns
// — GHCR accepts only classic PATs for pulls from outside GitHub, and the
// cluster has no identity a private package would trust. The config key keeps
// its historical name because trip was the first consumer; renaming it would
// mean re-setting the secret for no gain.
// Set with: pulumi config set --secret tripRegistryPullToken <token>
//
// foreman.ts deliberately keeps its own `foremanRegistryPullToken`.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const registryPullToken = new pulumi.Config().requireSecret(
  "tripRegistryPullToken",
);

// `auth` is base64("user:token") — the form kubelet actually reads.
export function ghcrPullSecret(
  name: string,
  namespace: pulumi.Input<string>,
): k8s.core.v1.Secret {
  return new k8s.core.v1.Secret(name, {
    metadata: {
      name,
      namespace,
    },
    type: "kubernetes.io/dockerconfigjson",
    stringData: {
      ".dockerconfigjson": registryPullToken.apply((token) =>
        Buffer.from(
          JSON.stringify({
            auths: {
              "ghcr.io": {
                username: "MaxMac99",
                password: token,
                auth: Buffer.from(`MaxMac99:${token}`).toString("base64"),
              },
            },
          }),
        ).toString("utf8"),
      ),
    },
  });
}
