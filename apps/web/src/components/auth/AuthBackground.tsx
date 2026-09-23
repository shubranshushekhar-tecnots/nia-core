import { dotGridStyle, pipeWrapStyle } from './styles';

export default function AuthBackground() {
  return (
    <>
      <div aria-hidden="true" style={dotGridStyle} />
      <div aria-hidden="true" style={pipeWrapStyle}>
        <svg viewBox="0 0 1080 560" width="100%" height="100%" style={{ display: 'block', overflow: 'visible' }}>
          <g fill="none" stroke="var(--line)" strokeWidth={1.5}>
            <path d="M 0,120 C 240,120 300,260 540,280" />
            <path d="M 0,420 C 230,420 330,318 540,280" />
            <path d="M 540,280 C 760,288 820,180 1080,180" />
            <path d="M 540,280 C 760,272 820,430 1080,430" />
          </g>
          <g fill="none" stroke="var(--flow)" strokeWidth={1.5} strokeDasharray="6 90" style={{ animation: 'pipeFlow 4.5s linear infinite' }}>
            <path d="M 0,120 C 240,120 300,260 540,280" />
          </g>
          <g fill="none" stroke="var(--flow)" strokeWidth={1.5} strokeDasharray="6 90" style={{ animation: 'pipeFlow 4.5s linear infinite -1.4s' }}>
            <path d="M 0,420 C 230,420 330,318 540,280" />
          </g>
          <g fill="none" stroke="var(--flow)" strokeWidth={1.5} strokeDasharray="6 90" style={{ animation: 'pipeFlow 4.5s linear infinite -2.6s' }}>
            <path d="M 540,280 C 760,288 820,180 1080,180" />
          </g>
          <g fill="none" stroke="var(--flow)" strokeWidth={1.5} strokeDasharray="6 90" style={{ animation: 'pipeFlow 4.5s linear infinite -3.4s' }}>
            <path d="M 540,280 C 760,272 820,430 1080,430" />
          </g>
          <circle r={3} fill="var(--packet)" style={{ offsetPath: "path('M 0,120 C 240,120 300,260 540,280')", animation: 'packetRun 4.8s linear infinite' } as never} />
          <circle r={3} fill="var(--packet)" style={{ offsetPath: "path('M 0,420 C 230,420 330,318 540,280')", animation: 'packetRun 5.2s linear infinite -1.6s' } as never} />
          <circle r={3} fill="var(--packet)" style={{ offsetPath: "path('M 540,280 C 760,288 820,180 1080,180')", animation: 'packetRun 5.6s linear infinite -2.8s' } as never} />
          <circle r={3} fill="var(--packet)" style={{ offsetPath: "path('M 540,280 C 760,272 820,430 1080,430')", animation: 'packetRun 4.5s linear infinite -3.6s' } as never} />
          <circle cx={540} cy={280} r={5} style={{ animation: 'nodePulse 4.5s linear infinite' }} />
          <circle cx={1080} cy={180} r={5} style={{ animation: 'nodePulse 5.6s linear infinite -2.8s' }} />
          <circle cx={1080} cy={430} r={5} style={{ animation: 'nodePulse 4.5s linear infinite -3.6s' }} />
        </svg>
      </div>
    </>
  );
}
