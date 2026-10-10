import type { Metadata } from 'next';
import { PublicFooter, PublicHeader } from '@/components/docs/PublicChrome';
import { AGENT_GUIDES } from '@/components/docs/guides';
import {
  nxDocsBodyStyle,
  nxDocsEyebrowStyle,
  nxDocsH1Style,
  nxDocsHeaderStyle,
  nxDocsIndexDescStyle,
  nxDocsIndexListStyle,
  nxDocsIndexRowStyle,
  nxDocsIndexTitleStyle,
  nxDocsPageStyle,
} from '@/components/docs/styles';

export const metadata: Metadata = {
  title: 'Docs',
  description: 'Guides for installing and running the Nia Core agent, from setup to monitoring and security.',
};

export default function AgentDocsIndexPage() {
  return (
    <div data-app-theme="" style={nxDocsPageStyle}>
      <PublicHeader />
      <header style={nxDocsHeaderStyle}>
        <span style={nxDocsEyebrowStyle}>Nia Core Agent</span>
        <h1 style={nxDocsH1Style}>Documentation</h1>
      </header>
      <div style={{ ...nxDocsBodyStyle, maxWidth: 1040 }}>
        <div style={nxDocsIndexListStyle}>
          {AGENT_GUIDES.map((guide) => (
            <a key={guide.slug} href={`/docs/agent/${guide.slug}`} className="nx-wipe" style={nxDocsIndexRowStyle}>
              <h2 style={nxDocsIndexTitleStyle}>{guide.title}</h2>
              <p style={nxDocsIndexDescStyle}>{guide.description}</p>
            </a>
          ))}
        </div>
      </div>
      <PublicFooter />
    </div>
  );
}
