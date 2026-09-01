# Adding an Authentik OIDC provider by hand

Written 2026-08-27, from the five providers that exist on Authentik 2026.5.6.

This estate does **not** declare OIDC providers in code. `auth/authentik-blueprints.ts`
captures the family enrollment flow and nothing else, deliberately — folding
providers in means folding their client secrets in, which means that ConfigMap
has to become a Secret first. Until that happens, every provider is created by
hand and only the resulting credentials live in `Pulumi.default.yaml`.

The consequence, stated plainly so nobody is surprised by it: **an Authentik
rebuild loses every provider.** This file is what you rebuild them from.

## Use the UI, not the API

⚠️ **The single most expensive mistake in this estate's Authentik history was
creating a provider through the REST API.** Creating an OAuth2 provider via the
API without an explicit `grant_types` leaves the field **empty**, so
`response_type=code` is not permitted and every login fails with
`invalid_request` / _"The request is otherwise malformed"_ — naming neither
grant types nor the provider. Immich surfaced it only as
`AuthorizationResponseError: authorization response from the server is an
error`. It was diagnosed by diffing the broken provider against the working
Grafana one.

**The UI populates that field for you. The API does not.** Use
`https://auth.mvissing.de/if/admin/` unless you have a reason not to, and if you
must use the API, set `grant_types` explicitly.

## The recipe

**Applications → Providers → Create → OAuth2/OpenID Provider.**

| Field              | Value                                             | Why                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization flow | `default-provider-authorization-implicit-consent` | All five existing providers use it. Explicit consent adds an "Allow?" page nobody in a homelab wants.                                                                                        |
| Invalidation flow  | `default-provider-invalidation-flow`              | Same as every existing provider.                                                                                                                                                             |
| Client type        | `confidential`                                    | The app can keep a secret. Anything running server-side is confidential.                                                                                                                     |
| Grant types        | `authorization_code`, `refresh_token`             | ⚠️ See above. Immich is set to exactly these two — narrower than Grafana and Paperless, which carry `implicit`, `password` and `client_credentials` they do not need. Copy Immich, not them. |
| Redirect URIs      | app-specific, `Strict`                            | See the table below.                                                                                                                                                                         |
| Signing key        | `authentik Self-signed Certificate`               | What all five use. It signs the ID token; the app trusts it via the discovery document, so self-signed is fine.                                                                              |
| Subject mode       | `hashed_user_id`                                  | Stable across username and email changes.                                                                                                                                                    |
| Issuer mode        | `per_provider`                                    | Gives each app its own issuer URL, `…/application/o/<slug>/`. Apps compare the `iss` claim against what they were configured with.                                                           |
| Scopes             | `openid`, `email`, `profile` + any custom         | ⚠️ Custom scopes must be added here **and** requested by the app. See below.                                                                                                                 |

Then **Applications → Applications → Create**, set the slug and point it at the
provider. Set **Launch URL** to the app's public address so it appears correctly
on Authentik's own dashboard.

Finally, copy the **Client ID** and **Client Secret** into the stack:

```bash
pulumi config set --secret <app>-oauth-client-id     '<id>'
pulumi config set --secret <app>-oauth-client-secret '<secret>'
```

## Redirect URIs actually in use

Wrong redirect URIs are the second most common failure and the error is always
`redirect_uri` mismatch, which at least names itself.

| App             | URIs                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immich          | `https://photos.mvissing.de/auth/login`, `https://photos.mvissing.de/user-settings`, `app.immich:///oauth-callback`                                  |
| Paperless       | `https://dms.mvissing.de/accounts/oidc/authentik/login/callback/`                                                                                    |
| Home Assistant  | `https://home.mvissing.de/auth/oidc/callback`                                                                                                        |
| Traefik outpost | `https://auth.mvissing.de/outpost.goauthentik.io/callback?X-authentik-auth-callback=true`, `https://auth.mvissing.de?X-authentik-auth-callback=true` |

⚠️ Immich needs **three**. `app.immich:///oauth-callback` is the mobile app's
deep link — omit it and the web UI works while the phone app fails, which reads
as an app bug.

## Restricting who can use an application

Membership, not provider configuration. **Applications → <app> → Policy /
Group / User Bindings → Bind existing group** and pick the group.

Immich uses `immich-users`. That binding is the switch: a user who is not a
member cannot reach the application, so Immich never provisions them — even
though `autoRegister: true`. `auth/authentik-blueprints.ts` puts family members
into that group automatically at enrollment.

## Custom scopes and claims

⚠️ **A custom scope is not requested by default and its absence is silent.** The
default scope list is `openid email profile`; a claim in a scope the app never
asks for is simply missing, and the app falls back to its own default. For
Immich that meant everyone would silently have become a regular user.

Two halves, and both are required:

1. **Customisation → Property Mappings → Create → Scope Mapping.** Immich's is
   named `Immich: immich_role`, scope name `immich_role`, returning `admin` for
   members of `admins` and `user` otherwise. Add it to the provider's **Scopes**.
2. **The app must request it.** In `apps/immich.ts`:
   `scope: "openid email profile immich_role"`.

Verify with the provider's own discovery document, which lists what is on offer:

```bash
curl -s https://auth.mvissing.de/application/o/<slug>/.well-known/openid-configuration \
  | jq '.issuer, .scopes_supported'
```

⚠️ **Immich applies OIDC claims at user creation only and never re-syncs them.**
Getting someone's role wrong on their first login is fixed in the Immich UI
afterwards, not by editing the mapping.

## Checking your work

```bash
# Every provider, with the fields that actually break logins.
kubectl exec -n authentik deploy/authentik-server -- ak shell -c "
from authentik.providers.oauth2.models import OAuth2Provider
for p in OAuth2Provider.objects.all().order_by('name'):
    print(p.name, '|', p.client_type, '|', p.grant_types)
    print('   ', [str(u.url) for u in p.redirect_uris])
    print('   ', [m.name for m in p.property_mappings.all()])
"
```

An empty `grant_types` list is the failure described at the top of this file.
