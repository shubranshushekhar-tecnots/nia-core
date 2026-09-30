import { redirect } from 'next/navigation';

// Subscription Phase 2, Slice 7: the minimal admin-only invites page
// (Slice 4) has been folded into /app/members (create/list/revoke, now
// alongside member list + role management). Keep this route alive as a
// redirect rather than deleting it outright — any bookmarked/linked URL
// still lands somewhere useful instead of a 404.
export default function InvitesPageRedirect() {
  redirect('/app/members');
}
