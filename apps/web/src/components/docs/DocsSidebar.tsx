import { AGENT_GUIDES } from './guides';
import {
  nxDocsSidebarDesktopStyle,
  nxDocsSidebarLinkStyle,
  nxDocsSidebarListStyle,
  nxDocsSidebarMobileStyle,
  nxDocsSidebarSummaryStyle,
} from './styles';

// Left sidebar for every /docs/agent/* guide page — all ten guides, the
// current one highlighted. Rendered twice (desktop list + mobile
// <details>), CSS (.nx-docs-sidebar-desktop/-mobile, packages/ui/src/
// theme.css) picks exactly one per viewport so this stays a plain server
// component with no client-side toggle state.
function GuideList({ activeSlug }: { activeSlug?: string }) {
  return (
    <nav style={nxDocsSidebarListStyle}>
      {AGENT_GUIDES.map((guide) => (
        <a
          key={guide.slug}
          href={`/docs/agent/${guide.slug}`}
          style={nxDocsSidebarLinkStyle(guide.slug === activeSlug)}
          aria-current={guide.slug === activeSlug ? 'page' : undefined}
        >
          {guide.title}
        </a>
      ))}
    </nav>
  );
}

export function DocsSidebar({ activeSlug }: { activeSlug?: string }) {
  return (
    <>
      <div className="nx-docs-sidebar-desktop" style={nxDocsSidebarDesktopStyle}>
        <GuideList activeSlug={activeSlug} />
      </div>
      <details className="nx-docs-sidebar-mobile" style={nxDocsSidebarMobileStyle}>
        <summary style={nxDocsSidebarSummaryStyle}>Guides</summary>
        <GuideList activeSlug={activeSlug} />
      </details>
    </>
  );
}
