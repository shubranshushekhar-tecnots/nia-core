import Logo from '@/components/Logo';
import Container from './hairline/Container';

const FOOTER_COLS = [
  { title: 'Product', links: [{ label: 'Canvas', href: '#canvas' }, { label: 'Connectors', href: '#connectors' }, { label: 'Pricing', href: '#pricing' }, { label: 'Sign in', href: '/login' }] },
  { title: 'Resources', links: [{ label: 'Docs', href: '#docs' }, { label: 'Changelog', href: '#changelog' }, { label: 'Status', href: '#status' }, { label: 'Support', href: '#support' }] },
  { title: 'Company', links: [{ label: 'About', href: '#about' }, { label: 'Careers', href: '#careers' }, { label: 'Privacy', href: '#privacy' }, { label: 'Terms', href: '#terms' }] },
];

// Ported from the "FOOTER" block shared by designs/Connectors — full
// page-html/Connectors.dc.html and designs/Pricing — full page-html/
// Pricing.dc.html (identical markup/copy in both, only the design tool's
// own "Reel NN · 00:00:00:00" frame-timecode label differs between the
// two files — a canvas-export artifact, not real product copy, so it's
// dropped rather than ported). Flat section, no card/rounded corners —
// sits directly below CtaBand's flat dark band with no parallax "rise"
// effect (that indigo-theme flourish doesn't fit the hairline system;
// previously took a footRef for the scroll-driven border-radius morph,
// now dropped along with the effect — see CtaBand.tsx's comment).
export default function Footer() {
  return (
    <footer className="hl-scope" style={{ background: 'var(--hl-ground)' }}>
      <Container style={{ paddingTop: 72, paddingBottom: 48, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: 80, flexWrap: 'wrap' }}>
          <div style={{ width: 320, flex: 'none' }}>
            <span style={{ display: 'inline-flex' }}>
              <Logo size={20} wordmarkColor="var(--hl-ink)" />
            </span>
            <p style={{ margin: '20px 0 0', fontSize: 14, lineHeight: '22px', color: 'var(--hl-ink-3)' }}>
              Draw the pipeline, schedule it, and wake up to dashboards that filled themselves.
            </p>
          </div>
          <div className="hl-footer-cols" style={{ flexGrow: 1 }}>
            {FOOTER_COLS.map((c) => (
              <div key={c.title}>
                <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--hl-ink-3)' }}>
                  {c.title}
                </div>
                <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {c.links.map((l) => (
                    <a key={l.label} href={l.href} className="hl-footer-link" style={{ fontSize: 15, color: 'var(--hl-ink-2)' }}>
                      {l.label}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 56, paddingTop: 28, borderTop: '1px solid var(--hl-rule-hairline)' }}>
          <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--hl-ink-3)' }}>
            &copy; 2026 Nia Core &middot; Rows moved responsibly
          </span>
        </div>
      </Container>
    </footer>
  );
}
