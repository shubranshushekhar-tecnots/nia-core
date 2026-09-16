import { INSPECTOR, NODES, TONE_VAR } from './config';
import type { NodeKind } from './config';

export default function Inspector({
  nodeId,
  isPinned,
  onFollowRun,
}: {
  nodeId: NodeKind;
  isPinned: boolean;
  onFollowRun: () => void;
}) {
  const content = INSPECTOR[nodeId];
  const node = NODES.find((n) => n.id === nodeId)!;
  const tone = TONE_VAR[node.tone];

  return (
    <div className="wr-inspector">
      <div className="wr-inspector-head">
        <div>
          <span className="wr-inspector-kicker" style={{ color: tone }}>{content.kicker}</span>
          <h4 className="wr-inspector-title">{content.title}</h4>
        </div>
        {isPinned ? (
          <button type="button" className="wr-follow-btn" onClick={onFollowRun}>Follow run</button>
        ) : (
          <span className="wr-following-pill">Following run</span>
        )}
      </div>

      <p className="wr-inspector-desc">{content.description}</p>

      {content.code && (
        <pre className="wr-code-block">
          {content.code.lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </pre>
      )}

      {content.bars && (
        <div className="wr-bars" aria-hidden="true">
          {content.bars.map((h, i) => (
            <span key={i} className="wr-bar" style={{ height: `${h * 100}%`, background: `color-mix(in srgb, ${tone} 70%, transparent)` }} />
          ))}
        </div>
      )}

      {content.ops && (
        <ul className="wr-ops-list">
          {content.ops.map((op, i) => (
            <li key={i}>{op}</li>
          ))}
        </ul>
      )}

      {content.resultPill && (
        <span className={`wr-result-pill wr-result-${content.resultPill.tone}`}>{content.resultPill.label}</span>
      )}
    </div>
  );
}
