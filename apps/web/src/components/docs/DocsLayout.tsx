import type { ReactNode } from 'react';
import {
  nxDocsBackLinkStyle,
  nxDocsBodyStyle,
  nxDocsEyebrowStyle,
  nxDocsH1Style,
  nxDocsHeaderStyle,
  nxDocsPageStyle,
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
  return (
    <div style={nxDocsPageStyle}>
      <header style={nxDocsHeaderStyle}>
        <a href="/docs/agent" style={nxDocsBackLinkStyle}>
          &larr; Nia Core Agent documentation
        </a>
        <span style={nxDocsEyebrowStyle}>Nia Core Agent</span>
        <h1 style={nxDocsH1Style}>{title}</h1>
      </header>
      <div style={nxDocsBodyStyle}>
        {children}
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
  );
}
