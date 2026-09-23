import Container from './hairline/Container';
import Eyebrow from './hairline/Eyebrow';
import Button from './hairline/Button';
import { bandH2 } from './hairline/styles';

const APP = 'Nia Core Shell.dc.html';

// Closing CTA band — ported from the "CLOSING BAND" block shared by
// designs/Connectors — full page-html/Connectors.dc.html and
// designs/Pricing — full page-html/Pricing.dc.html (identical copy in
// both). Flat #101014 ground, no gradient/rounded card — matches the
// hairline system now that Footer.tsx sits on the same flat dark band
// with no "rise from under" seam. (Previously took a bandRef used for a
// scroll-driven 3D scale/blur/rotate effect designed for the old rounded
// gradient card + overlapping footer; both are gone with the flat
// hairline layout, so the ref was dropped along with the effect.)
export default function CtaBand() {
  return (
    <section className="hl-scope" style={{ background: 'var(--hl-ink)' }}>
      <Container style={{ paddingTop: 104, paddingBottom: 104 }}>
        <Eyebrow tone="inverted">No card &middot; five minutes &middot; cancel whenever</Eyebrow>
        <h2 style={{ ...bandH2, marginTop: 28, maxWidth: 820 }}>Move your first million rows tonight.</h2>
        <div style={{ marginTop: 44, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Button href={APP} variant="solid" ground="dark">Start free — no card</Button>
          <Button href="#sales" variant="outline" ground="dark">Talk to sales</Button>
        </div>
      </Container>
    </section>
  );
}
