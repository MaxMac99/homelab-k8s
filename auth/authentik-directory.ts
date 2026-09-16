// Authentik directory — users, the estate admins group, and API tokens.
//
// Adopted from UI-created objects via `pulumi import`; the values mirror what
// the UI made.
//
// ⚠️ Passwords are deliberately NOT managed here. The provider only sets a
// password on resource *creation* (never on update), so adoption is safe —
// but it also means a password reset stays a UI action (or akadmin recovery).
// Managing passwords from code would put credentials in git-adjacent state
// for no operational gain.

import * as authentik from "@pulumi/authentik";

// Max is the akadmin-equivalent estate owner (superuser flag is authentik-
// internal, not exposed to this provider).
export const userMax = new authentik.User("user-max", {
  username: "Max",
  name: "Max",
  email: "max_vissing@yahoo.de",
});

export const userMichael = new authentik.User("user-michael", {
  username: "Michael",
  name: "Michael",
  email: "vissing@t-online.de",
});

export const userSilke = new authentik.User("user-silke", {
  username: "Silke",
  name: "Silke",
  email: "silke.vissing@gmx.de",
});

export const userAnna = new authentik.User("user-anna", {
  username: "anna",
  name: "Anna",
  email: "anna.vissing@yahoo.de",
});

// The estate-admins group the immich_role mapping checks (apps/immich.ts).
// Membership IS managed here: adding an admin is a code change, like
// everything else in this estate.
export const adminsGroup = new authentik.Group("admins-group", {
  name: "admins",
  // Superuser-granting group (estate pattern) — dropping this would silently
  // demote every member, so it is part of the declaration.
  isSuperuser: true,
  users: [userMax.id.apply(Number)],
});

// The API token the Homepage widget uses (gethomepage.dev/widget.key in
// apps/homepage.ts). Adopted without its key — token keys are write-only in
// the API, so the existing key is untouched and unknown to state. The value
// Homepage actually sends still comes from the `authentikApiToken` stack
// secret; this resource only manages the token's *record*.
//
// The live record carries a stale `expires` timestamp from its creation even
// though `expiring` is false; that field is omitted here, so the first apply
// nulls it out. Cosmetic — expiring=false ignores it.
export const homepageApiToken = new authentik.Token("authentik-api-token", {
  identifier: "authentikApiToken",
  user: userMax.id.apply(Number),
  intent: "api",
  expiring: false,
});
