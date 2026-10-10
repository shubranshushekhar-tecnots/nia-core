import type { Metadata } from 'next';
import DownloadsPage from '@/components/downloads/DownloadsPage';
import { getDownloadManifest, getDownloadUrl } from '@/lib/downloads/manifest';
import { getSessionUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Downloads' };

export const dynamic = 'force-dynamic';

export default async function Page() {
  const sessionUser = await getSessionUser();

  try {
    const manifest = await getDownloadManifest();
    const downloadUrls: Record<string, string> = {};
    for (const file of manifest.files) downloadUrls[file.name] = getDownloadUrl(file);

    return (
      <DownloadsPage
        version={manifest.version}
        files={manifest.files}
        downloadUrls={downloadUrls}
        signedIn={Boolean(sessionUser)}
      />
    );
  } catch {
    // No packages built yet in this environment (fresh dev checkout before
    // running apps/agent's build + generate-manifest scripts, or a
    // production AGENT_DOWNLOADS_BASE_URL that isn't reachable yet).
    return (
      <div data-app-theme="" style={{ minHeight: '100vh', background: 'var(--nx-bg)', padding: 40, color: 'var(--nx-ink-2)' }}>
        Downloads are not available yet. Check back soon.
      </div>
    );
  }
}
