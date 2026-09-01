// Authentik blueprints — the first Authentik configuration this repo actually
// owns.
//
// Everything Authentik knows today was clicked in or POSTed by hand: the OIDC
// providers for Grafana, Paperless and Immich, the `immich-users` group, the
// policy bindings. `docs/immich-migration.md` Phase E records the consequence —
// *"an Authentik rebuild means recreating all of this by hand"*. Blueprints are
// Authentik's own answer to that, and this file is the mount point for them.
//
// **How they get applied.** Authentik's worker discovers YAML under
// `/blueprints` and instantiates each file it finds, unless the file carries
// the label `blueprints.goauthentik.io/instantiate: "false"` — which is exactly
// what the bundled `example/` blueprints use to stay dormant. Ours carry no
// such label, so they apply. The image ships `default/`, `example/`, `system/`
// and friends; this mounts a *new* subdirectory beside them rather than over
// them, because replacing `/blueprints` wholesale would hide the `default/`
// blueprints that build the stock flows Authentik cannot run without.
//
// ⚠️ **Discovery runs on a timer, not on a file change.** A blueprint edit is
// picked up at worker start and then roughly hourly. `blueprintsChecksum` below
// exists so a `pulumi up` that changes the YAML also rolls the pods, instead of
// appearing to do nothing for up to an hour.
//
// ⚠️ **A ConfigMap, not a Secret, and that constrains what may go in here.**
// Nothing below is a credential. If the OIDC providers are ever folded into a
// blueprint — which is the obvious next step and would close the Phase E gap —
// the client secrets come with them and this must become a Secret first.

import * as crypto from "crypto";

/**
 * Where the blueprints are mounted inside both Authentik containers.
 *
 * ⚠️ A subdirectory of `/blueprints`, never `/blueprints` itself. See the
 * header: mounting over the parent hides `default/`, and Authentik's stock
 * flows are built from it.
 */
export const BLUEPRINTS_MOUNT_PATH = "/blueprints/custom";

/**
 * Invitation-only enrollment, for family members.
 *
 * The shape of the thing, and why each piece is there:
 *
 *   1. **Invitation stage**, `continue_flow_without_invitation: false`. This is
 *      the entire access control. The flow has a public URL — anything under
 *      `/if/flow/` on `auth.mvissing.de` is reachable from the internet — and
 *      what stops a stranger walking through it is that the first stage refuses
 *      to proceed without a valid token. ⚠️ Flipping that boolean turns this
 *      into open public signup on an internet-facing IdP whose members can see
 *      the family photo library.
 *   2. **Two prompt stages**, credentials then details. Split the way the
 *      bundled examples split them, so the person picks a username and password
 *      on one screen and gives a name and email on the next.
 *   3. **User write**, with `create_users_group` pointed at `immich-users`.
 *      ⚠️ This is the only automatic route into that group, and membership in
 *      it is what the Immich application's policy binding checks. Immich itself
 *      provisions on first login (`autoRegister: true` in `apps/immich.ts`), so
 *      the chain is: token → account → group → Immich account. Nobody who is
 *      not handed a token ends up with photos.
 *      ⚠️ Groups deliberately cannot be set from an invitation's `fixed_data` —
 *      the relation has to exist after the user does — so the group is a
 *      property of the *flow*, which is why there is one flow per audience
 *      rather than one flow with a variable group.
 *   4. **TOTP setup**, after user write and before login. Not optional, and the
 *      reason is `apps/immich.ts`: `passwordLogin` is off there, so Authentik
 *      is the only door to a library that is now on the public internet. The
 *      existing `default-authentication-mfa-validation` stage on
 *      `default-authentication-flow` then challenges them at every subsequent
 *      login, because they have a device — that stage skips users who do not.
 *      ⚠️ There is no SMTP on this Authentik, so there is also no self-service
 *      recovery. A family member who loses their phone needs the device deleted
 *      from the admin interface. That is the accepted cost of MFA here.
 *   5. **User login**, so enrollment ends signed in rather than at a login form.
 *
 * ⚠️ **The brand's enrollment flow is deliberately left unset.** Setting it
 * would put a "Sign up" link on the login page for every visitor. The only way
 * in is a link you send someone:
 *
 *     https://auth.mvissing.de/if/flow/family-enrollment/?itoken=<token>
 *
 * Minting a token is `Directory → Invitations → Create` in the admin interface,
 * with **Flow** set to this one — an invitation with no flow is valid for
 * *any* invitation stage, which is not what is wanted. Single-use, and give it
 * an expiry.
 *
 * ⚠️ `state: created` on the group, not the default `present`. `immich-users`
 * already exists, holds Max, and is the target of a policy binding made by
 * hand; this blueprint needs to *reference* it, not take ownership of it and
 * risk rewriting it out from under that binding.
 */
const familyEnrollmentBlueprint = `# Managed by Pulumi — auth/authentik-blueprints.ts. Edit there, not here.
version: 1
metadata:
  name: Family enrollment (invitation only)
entries:
  # The group Immich's application policy binding checks. Created by hand in
  # Phase E; adopted read-only here so user-write below can point at it.
  - identifiers:
      name: immich-users
    id: group-immich-users
    model: authentik_core.group
    state: created
    attrs:
      is_superuser: false

  - identifiers:
      slug: family-enrollment
    id: flow
    model: authentik_flows.flow
    attrs:
      name: Family enrollment
      title: Willkommen! Richte deinen Zugang ein.
      designation: enrollment
      authentication: require_unauthenticated

  # The access control for the whole flow. See the note in the TypeScript.
  - identifiers:
      name: family-enrollment-invitation
    id: invitation-stage
    model: authentik_stages_invitation.invitationstage
    attrs:
      continue_flow_without_invitation: false

  - identifiers:
      name: family-enrollment-field-username
    id: prompt-field-username
    model: authentik_stages_prompt.prompt
    attrs:
      field_key: username
      label: Benutzername
      type: username
      required: true
      placeholder: Benutzername
      placeholder_expression: false
      order: 0

  - identifiers:
      name: family-enrollment-field-password
    id: prompt-field-password
    model: authentik_stages_prompt.prompt
    attrs:
      field_key: password
      label: Passwort
      type: password
      required: true
      placeholder: Passwort
      placeholder_expression: false
      order: 1

  - identifiers:
      name: family-enrollment-field-password-repeat
    id: prompt-field-password-repeat
    model: authentik_stages_prompt.prompt
    attrs:
      field_key: password_repeat
      label: Passwort (wiederholen)
      type: password
      required: true
      placeholder: Passwort (wiederholen)
      placeholder_expression: false
      order: 2

  - identifiers:
      name: family-enrollment-field-name
    id: prompt-field-name
    model: authentik_stages_prompt.prompt
    attrs:
      field_key: name
      label: Name
      type: text
      required: true
      placeholder: Vor- und Nachname
      placeholder_expression: false
      order: 0

  # ⚠️ Load-bearing beyond identity. Immich matches an OIDC login to an existing
  # account by email, which is how Max's Authentik login attached to the Immich
  # admin created before OIDC existed rather than making a second account. A
  # typo here means a second, empty Immich account for that person.
  - identifiers:
      name: family-enrollment-field-email
    id: prompt-field-email
    model: authentik_stages_prompt.prompt
    attrs:
      field_key: email
      label: E-Mail
      type: email
      required: true
      placeholder: E-Mail
      placeholder_expression: false
      order: 1

  - identifiers:
      name: family-enrollment-prompt-credentials
    id: prompt-stage-credentials
    model: authentik_stages_prompt.promptstage
    attrs:
      fields:
        - !KeyOf prompt-field-username
        - !KeyOf prompt-field-password
        - !KeyOf prompt-field-password-repeat

  - identifiers:
      name: family-enrollment-prompt-details
    id: prompt-stage-details
    model: authentik_stages_prompt.promptstage
    attrs:
      fields:
        - !KeyOf prompt-field-name
        - !KeyOf prompt-field-email

  - identifiers:
      name: family-enrollment-user-write
    id: user-write-stage
    model: authentik_stages_user_write.userwritestage
    attrs:
      user_creation_mode: always_create
      user_type: internal
      user_path_template: users/family
      create_users_group: !KeyOf group-immich-users

  # ⚠️ No configure_flow. That field is for reaching this stage from user
  # settings later; bound directly into a flow it runs inline, which is the
  # point — enrollment is the one moment the person is guaranteed to be here.
  - identifiers:
      name: family-enrollment-totp-setup
    id: totp-stage
    model: authentik_stages_authenticator_totp.authenticatortotpstage
    attrs:
      friendly_name: Authenticator-App
      digits: 6

  - identifiers:
      name: family-enrollment-user-login
    id: user-login-stage
    model: authentik_stages_user_login.userloginstage

  # ⚠️ evaluate_on_plan/re_evaluate_policies, per Authentik's own bundled
  # invitation example. The token arrives as a query parameter, so the stage has
  # to be re-planned against the actual request rather than a cached plan.
  - identifiers:
      target: !KeyOf flow
      stage: !KeyOf invitation-stage
      order: 5
    model: authentik_flows.flowstagebinding
    attrs:
      evaluate_on_plan: true
      re_evaluate_policies: true

  - identifiers:
      target: !KeyOf flow
      stage: !KeyOf prompt-stage-credentials
      order: 10
    model: authentik_flows.flowstagebinding

  - identifiers:
      target: !KeyOf flow
      stage: !KeyOf prompt-stage-details
      order: 15
    model: authentik_flows.flowstagebinding

  - identifiers:
      target: !KeyOf flow
      stage: !KeyOf user-write-stage
      order: 20
    model: authentik_flows.flowstagebinding

  # ⚠️ After user-write and before user-login. Before user-write there is no
  # user to attach a device to; after user-login the person is already in and
  # could simply close the tab.
  - identifiers:
      target: !KeyOf flow
      stage: !KeyOf totp-stage
      order: 30
    model: authentik_flows.flowstagebinding

  - identifiers:
      target: !KeyOf flow
      stage: !KeyOf user-login-stage
      order: 100
    model: authentik_flows.flowstagebinding
`;

/**
 * Every blueprint file, keyed by the filename it gets in the mount.
 *
 * ⚠️ Exported as data rather than as a ConfigMap resource. `authentik.ts` owns
 * the namespace *and* the two Deployments that mount this, so it builds the
 * ConfigMap; creating it here would mean importing the namespace from there
 * while that file imports the mount path from here, which is a cycle.
 */
export const blueprints: Record<string, string> = {
  "family-enrollment.yaml": familyEnrollmentBlueprint,
};

/**
 * Content hash of every blueprint, for a pod-template annotation.
 *
 * ⚠️ This is what makes an edit take effect. A ConfigMap change does not roll
 * the pods that mount it, and Authentik rescans `/blueprints` only at worker
 * start and then on an hourly timer — so without this a `pulumi up` reports
 * success and the change lands up to an hour later, or looks like it did not
 * land at all. Hashing the source strings rather than the ConfigMap's output
 * keeps the value known at preview time.
 */
export const blueprintsChecksum = crypto
  .createHash("sha256")
  .update(JSON.stringify(blueprints))
  .digest("hex")
  .slice(0, 16);
