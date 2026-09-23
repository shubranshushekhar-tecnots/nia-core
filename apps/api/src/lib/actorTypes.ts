import type { ActorRole, OrgRole } from "@nia/schemas";

export type OrgRef = { id: string; name: string; slug: string };

/**
 * Mirrors apps/web/src/lib/auth/session.ts's UserContext exactly — same
 * shape, same "individual" synthetic role for org-less users. Kept as a
 * separate type here (not imported from apps/web) since apps never depend
 * on each other's source.
 */
export type UserContext = {
  userId: string;
  email: string;
  fullName: string | null;
  org: OrgRef | null;
  role: ActorRole;
};

export type UserWithOrg = {
  userId: string;
  email: string;
  fullName: string | null;
  org: OrgRef;
  role: OrgRole;
};
