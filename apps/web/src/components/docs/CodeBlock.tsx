import CopyButton from './CopyButton';
import { nxDocsCodeBlockStyle, nxDocsCodeBlockWrapStyle, nxDocsCodeCopyBtnStyle } from './styles';

// A <pre> code block with a copy button pinned to its top-right corner —
// used by every /docs/agent/* guide that shows a command to run.
export function CodeBlock({ code }: { code: string }) {
  return (
    <div style={nxDocsCodeBlockWrapStyle}>
      <pre style={nxDocsCodeBlockStyle}>{code}</pre>
      <CopyButton text={code} style={nxDocsCodeCopyBtnStyle} />
    </div>
  );
}
