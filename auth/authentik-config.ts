// Authentik configuration-as-code — shared lookups.
//
// The k8s side (authentik.ts, authentik-outpost.ts) deploys the server and the
// outpost. The `authentik/*` files manage Authentik's *contents* —
// applications, providers, outpost, users, groups, tokens — as code, through
// the official Terraform provider (`goauthentik/authentik`) generated into
// sdks/authentik (see the `packages:` block in Pulumi.yaml).
//
// The provider is the package-default one, configured from stack config:
//   authentik:url   — the Authentik root (https://auth.mvissing.de)
//   authentik:token — an API token (Directory → Tokens & App passwords,
//                     intent API); stored with `pulumi config set --secret`
// Off-LAN, point it at a port-forward for one run — the API (and the admin UI
// for token creation) are the same server either way:
//   kubectl -n authentik port-forward svc/authentik 18080:80
//   pulumi preview -c 'authentik:url=http://127.0.0.1:18080'
// The `-c` flag overrides for that one run without touching Pulumi.default.yaml.
//
// Upgrades: re-run
//   pulumi package add terraform-provider goauthentik/authentik <version>
// which regenerates sdks/authentik and bumps the pin in Pulumi.yaml in one
// step. Renovate cannot do this (sdks/ is generated code, not a registry
// dependency), so it stays manual.
//
// ⚠️ Every preview and up now talks to the live Authentik API — the
// data-source lookups below resolve during the program run, and every
// authentik resource drift-checks against it. If Authentik is unreachable,
// the run fails early in the provider; the k8s half of the estate is
// unaffected.

import * as authentik from "@pulumi/authentik";

// The authorization flow the UI preselects for new providers (implicit
// consent — no per-app consent screen; this is a single-household estate).
export const defaultAuthorizationFlow = authentik.getFlowOutput({
  slug: "default-provider-authorization-implicit-consent",
});

// The flow that ends the app session on sign-out.
export const defaultInvalidationFlow = authentik.getFlowOutput({
  slug: "default-provider-invalidation-flow",
});

// The scope mappings the UI preselects for a new proxy provider — Trip (made
// in the UI) carries exactly these five. OAuth2 providers use the first
// three. Referenced by `managed`-id — fixed by authentik upstream and stable
// across upgrades — so the UUIDs are resolved at run time, not hardcoded.
export const scopeMapping = {
  openid: "goauthentik.io/providers/oauth2/scope-openid",
  email: "goauthentik.io/providers/oauth2/scope-email",
  profile: "goauthentik.io/providers/oauth2/scope-profile",
  entitlements: "goauthentik.io/providers/oauth2/scope-entitlements",
  proxy: "goauthentik.io/providers/proxy/scope-proxy",
};

const mappingId = (managed: string) =>
  authentik.getPropertyMappingProviderScopeOutput({ managed }).id;

export const oauth2ScopeMappings = [
  mappingId(scopeMapping.openid),
  mappingId(scopeMapping.email),
  mappingId(scopeMapping.profile),
];

export const proxyScopeMappings = [
  ...oauth2ScopeMappings,
  mappingId(scopeMapping.entitlements),
  mappingId(scopeMapping.proxy),
];

// Authentik's auto-generated self-signed certificate. Every OAuth2 provider
// here signs with it. ⚠️ This must stay on every oauth2 provider: the field
// is optional-but-not-computed in the provider, so omitting it would *clear*
// the signing key on the next apply and invalidate every OIDC client.
export const signingKey = "5295ba28-2656-4620-b580-9e6d9ccd616c";
