'use client';

import { useEffect, useState } from 'react';
import CopyButton from '@/components/docs/CopyButton';
import { PublicFooter, PublicHeader } from '@/components/docs/PublicChrome';
import { buildDownloadCards } from '@/lib/downloads/buildDownloadCards';
import type { AgentOs, DownloadManifestFile } from '@/lib/downloads/manifest';
import {
  nxDownloadsAddAgentLinkStyle,
  nxDownloadsAdvancedLinkStyle,
  nxDownloadsBadgeStyle,
  nxDownloadsBodyTextStyle,
  nxDownloadsButtonNameStyle,
  nxDownloadsCardsGridStyle,
  nxDownloadsCardStyle,
  nxDownloadsCardTopRowStyle,
  nxDownloadsChecksumRowStyle,
  nxDownloadsChecksumStyle,
  nxDownloadsCodeChipStyle,
  nxDownloadsEyebrowStyle,
  nxDownloadsGuideLinkStyle,
  nxDownloadsGuidesListStyle,
  nxDownloadsH1Style,
  nxDownloadsHeaderStyle,
  nxDownloadsMetaRowStyle,
  nxDownloadsNoticeStyle,
  nxDownloadsOsNameStyle,
  nxDownloadsPageStyle,
  nxDownloadsPrimaryBtnStyle,
  nxDownloadsReqTextStyle,
  nxDownloadsSecondaryBtnStyle,
  nxDownloadsSectionStyle,
  nxDownloadsSectionTitleStyle,
  nxDownloadsSeeLinkStyle,
  nxDownloadsSubtitleStyle,
  nxDownloadsVersionRowStyle,
  nxDownloadsYourSystemStyle,
} from './styles';

const OS_LABEL: Record<AgentOs, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

const OS_REQUIREMENT: Record<AgentOs, string> = {
  windows: 'Needs Windows 10 or later, 64-bit.',
  macos: 'Needs macOS 11 or later, on Apple Silicon (M1 or newer).',
  linux: 'Needs a 64-bit Linux system.',
};

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function detectOs(): AgentOs | null {
  if (typeof navigator === 'undefined') return null;
  const ua = `${navigator.userAgent} ${navigator.platform ?? ''}`.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return null;
}

export default function DownloadsPage({
  version,
  files,
  downloadUrls,
  signedIn,
}: {
  version: string;
  files: DownloadManifestFile[];
  downloadUrls: Record<string, string>;
  signedIn?: boolean;
}) {
  const [visitorOs, setVisitorOs] = useState<AgentOs | null>(null);

  useEffect(() => {
    setVisitorOs(detectOs());
  }, []);

  const cards = buildDownloadCards(files);

  return (
    <div data-app-theme="" style={nxDownloadsPageStyle}>
      <PublicHeader />
      <header style={nxDownloadsHeaderStyle}>
        <span style={nxDownloadsEyebrowStyle}>Nia Core Agent</span>
        <h1 style={nxDownloadsH1Style}>Download Nia Core Agent</h1>
        <p style={nxDownloadsSubtitleStyle}>
          The Nia Core Agent runs inside your own network, on a machine your team controls. It
          reads your databases using a read-only login you create, and sends data only to the
          destinations you explicitly allow.{' '}
          <a href="/docs/agent/security" style={nxDownloadsSeeLinkStyle}>
            See what leaves your network
          </a>
          .
        </p>
        <div style={nxDownloadsNoticeStyle}>
          These packages are not yet code-signed. Windows and macOS will both show a warning the
          first time you run one — see &quot;Running an unsigned package&quot; below for the exact
          click-through steps.
        </div>
        <div style={nxDownloadsVersionRowStyle}>Version {version}</div>
        {signedIn && (
          <a href="/app/agents" style={nxDownloadsAddAgentLinkStyle}>
            Already installed? Add an agent
          </a>
        )}
      </header>

      <div style={nxDownloadsCardsGridStyle}>
        {cards.map(({ os, primary, advanced }) => {
          const isVisitorOs = visitorOs === os;
          return (
            <div key={os} style={nxDownloadsCardStyle(isVisitorOs)}>
              <div style={nxDownloadsCardTopRowStyle}>
                <h2 style={nxDownloadsOsNameStyle}>{OS_LABEL[os]}</h2>
                {os === 'windows' && <span style={nxDownloadsBadgeStyle}>New</span>}
                {isVisitorOs && <span style={nxDownloadsYourSystemStyle}>Your system</span>}
              </div>
              <p style={nxDownloadsReqTextStyle}>{OS_REQUIREMENT[os]}</p>
              <div style={nxDownloadsMetaRowStyle}>
                <span>{formatSize(primary.size)}</span>
                <div style={nxDownloadsChecksumRowStyle}>
                  <span style={nxDownloadsChecksumStyle}>SHA-256: {primary.sha256}</span>
                  <CopyButton text={primary.sha256} />
                </div>
              </div>
              <a
                href={downloadUrls[primary.name]}
                style={isVisitorOs ? nxDownloadsPrimaryBtnStyle() : nxDownloadsSecondaryBtnStyle()}
              >
                Download for {OS_LABEL[os]}
              </a>
              {advanced && (
                <a href={downloadUrls[advanced.name]} style={nxDownloadsAdvancedLinkStyle}>
                  Advanced: portable .zip ({formatSize(advanced.size)}, no installer)
                </a>
              )}
            </div>
          );
        })}
      </div>

      <section style={nxDownloadsSectionStyle}>
        <h3 style={nxDownloadsSectionTitleStyle}>Running an unsigned package</h3>
        <p style={nxDownloadsBodyTextStyle}>
          <strong>Windows:</strong> Microsoft SmartScreen will say &quot;Windows protected your
          PC.&quot; Click <span style={nxDownloadsButtonNameStyle}>More info</span>, then{' '}
          <span style={nxDownloadsButtonNameStyle}>Run anyway</span>.
        </p>
        <p style={nxDownloadsBodyTextStyle}>
          <strong>macOS:</strong> Gatekeeper will refuse to open the app because it wasn&apos;t
          downloaded from the App Store or signed by an identified developer. After unzipping,
          run this once in Terminal, then open it normally:
        </p>
        <p style={nxDownloadsBodyTextStyle}>
          <span style={nxDownloadsCodeChipStyle}>xattr -d com.apple.quarantine nia-agent</span>
        </p>
      </section>

      <section style={nxDownloadsSectionStyle}>
        <h3 style={nxDownloadsSectionTitleStyle}>Guides</h3>
        <div style={nxDownloadsGuidesListStyle}>
          <a href="/docs/agent/getting-started" style={nxDownloadsGuideLinkStyle}>
            Getting started &mdash; the whole journey in five steps
          </a>
          <a href="/docs/agent/install-windows" style={nxDownloadsGuideLinkStyle}>
            Install on Windows
          </a>
          <a href="/docs/agent/install-macos" style={nxDownloadsGuideLinkStyle}>
            Install on macOS
          </a>
          <a href="/docs/agent/install-linux" style={nxDownloadsGuideLinkStyle}>
            Install on Linux
          </a>
          <a href="/docs/agent/security" style={nxDownloadsGuideLinkStyle}>
            Security &mdash; what leaves your network
          </a>
        </div>
      </section>
      <PublicFooter />
    </div>
  );
}
