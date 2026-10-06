import type { ReactNode } from 'react';
import { PublicFooter, PublicHeader } from './PublicChrome';
import { DocsSidebar } from './DocsSidebar';
import { AGENT_GUIDES } from './guides';
import {
  nxDocsBackLinkStyle,
  nxDocsBodyStyle,
  nxDocsEyebrowStyle,
  nxDocsH1Style,
  nxDocsHeaderStyle,
  nxDocsLayoutStyle,
  nxDocsPageStyle,
  nxDocsPrevNextLabelStyle,
  nxDocsPrevNextLinkStyle,
  nxDocsPrevNextStyle,
  nxDocsPrevNextTitleStyle,
  nxDocsSeeAlsoLinkStyle,
  nxDocsSeeAlsoStyle,
} from './styles';

export function DocsLayout({
  title,
  children,
  seeAlso,
}: {
  title: string;
  children: ReactNode;
  seeAlso?: { href: string; label: string }[];
}) {
  // Every guide page passes its exact AGENT_GUIDES title as `title` — matching
  // on that (rather than threading a separate `slug` prop through all ten
  // page files) is enough to know which sidebar entry to highlight and what
  // sits before/after it, with zero call-site changes.
  const index = AGENT_GUIDES.findIndex((guide) => guide.title === title);
  const activeSlug = index >= 0 ? AGENT_GUIDES[index]?.slug : undefined;
  const prev = index > 0 ? AGENT_GUIDES[index - 1] : undefined;
  const next = index >= 0 && index < AGENT_GUIDES.length - 1 ? AGENT_GUIDES[index + 1] : undefined;

  return (
    <div data-app-theme="" style={nxDocsPageStyle}>
      <PublicHeader />
      <header style={nxDocsHeaderStyle}>
        <a href="/docs/agent" style={nxDocsBackLinkStyle}>
          &larr; Nia Core Agent documentation
        </a>
        <span style={nxDocsEyebrowStyle}>Nia Core Agent</span>
        <h1 style={nxDocsH1Style}>{title}</h1>
      </header>
      <div className="nx-docs-layout" style={nxDocsLayoutStyle}>
        <DocsSidebar activeSlug={activeSlug} />
        <div style={nxDocsBodyStyle}>
          {children}

          {(prev || next) && (
            <nav style={nxDocsPrevNextStyle} aria-label="Guide navigation">
              {prev ? (
                <a href={`/docs/agent/${prev.slug}`} style={nxDocsPrevNextLinkStyle('left')}>
                  <span style={nxDocsPrevNextLabelStyle}>&larr; Previous</span>
                  <span style={nxDocsPrevNextTitleStyle}>{prev.title}</span>
                </a>
              ) : (
                <span />
              )}
              {next ? (
                <a href={`/docs/agent/${next.slug}`} style={nxDocsPrevNextLinkStyle('right')}>
                  <span style={nxDocsPrevNextLabelStyle}>Next &rarr;</span>
                  <span style={nxDocsPrevNextTitleStyle}>{next.title}</span>
                </a>
              ) : (
                <span />
              )}
            </nav>
          )}

          {seeAlso && seeAlso.length > 0 && (
            <div style={nxDocsSeeAlsoStyle}>
              <span style={nxDocsEyebrowStyle}>See also</span>
              {seeAlso.map((link) => (
                <a key={link.href} href={link.href} style={nxDocsSeeAlsoLinkStyle}>
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
      <PublicFooter />
    </div>
  );
}
