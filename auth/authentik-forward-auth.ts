// Authentik forward auth — the domain-level proxy provider, its application,
// and the outpost record they hang off.
//
// The "Traefik" provider here is the domain-level forward auth for all of
// .mvissing.de: every site's traefik consults the outpost (deployed by
// authentik-outpost.ts), which authenticates against this provider and sets
// the estate-wide session cookie. Per-app forward auth (Trip, Meals) uses its
// own single-application provider instead and lives in that app's file.
//
// Adopted from UI-created objects via `pulumi import` — the values below
// mirror what the UI made, so a fresh `pulumi preview` is a no-op.

import * as authentik from "@pulumi/authentik";
import {
  defaultAuthorizationFlow,
  defaultInvalidationFlow,
  proxyScopeMappings,
} from "./authentik-config";
import { adminsGroup } from "./authentik-directory";

const forwardAuthProvider = new authentik.ProviderProxy(
  "forward-auth-domain-provider",
  {
    name: "Traefik",
    mode: "forward_domain",
    externalHost: "https://auth.mvissing.de",
    // Leading dot: the session cookie covers every subdomain, which is what
    // makes one login work across all forward-auth'd apps.
    cookieDomain: ".mvissing.de",
    authorizationFlow: defaultAuthorizationFlow.id,
    invalidationFlow: defaultInvalidationFlow.id,
    propertyMappings: proxyScopeMappings,
    // The UI's default for a fresh provider, made explicit.
    accessTokenValidity: "hours=24",
  },
);

const forwardAuthApplication = new authentik.Application(
  "forward-auth-domain-application",
  {
    name: "Traefik",
    slug: "traefik",
    protocolProvider: forwardAuthProvider.providerProxyId.apply(Number),
  },
);

// The outpost record — the single proxy outpost the traefik middlewares
// already point at. (The k8s Deployment serving it is Pulumi-managed in
// authentik-outpost.ts; this is the record *inside* Authentik that the pod
// authenticates against.)
//
// ⚠️ `ignoreChanges` on `protocolProviders` is load-bearing. The record's two
// pre-existing attachments (this provider and Trip) were made in the UI and
// predate config-as-code; managing the list here AND per-app attachment
// resources would make the two fight over the same membership rows. The list
// is therefore frozen as-is, and each app file manages its own attachment
// (see meals.ts).
const forwardAuthOutpostRecord = new authentik.Outpost(
  "forward-auth-outpost",
  {
    name: "k8s-forward-auth",
    type: "proxy",
    protocolProviders: [forwardAuthProvider.providerProxyId.apply(Number)],
  },
  { ignoreChanges: ["protocolProviders"] },
);

// Authorization: only admins may open the forward-auth application tile —
// the estate pattern (every app binds one group; see the per-app files).
// The outpost still serves *requests* for any attached provider; this gate is
// about the application entry on the Authentik dashboard.
new authentik.PolicyBinding("forward-auth-domain-binding", {
  target: forwardAuthApplication.uuid,
  group: adminsGroup.id,
  order: 0,
});

export {
  forwardAuthProvider,
  forwardAuthApplication,
  forwardAuthOutpostRecord,
};
