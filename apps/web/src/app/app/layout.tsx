// Every page under app/app/* is per-user (requireUser()/getSessionUser()
// reads the caller's session + org membership from the DB), so none of
// them may ever be prerendered at build time — there is no "anonymous"
// version of these pages to serve statically, and DATABASE_URL is only
// present at runtime, not at build time (see lib/db/pool.ts, lib/auth/auth.ts).
export const dynamic = "force-dynamic";

export default function AppSectionLayout({ children }: { children: React.ReactNode }) {
  return children;
}
