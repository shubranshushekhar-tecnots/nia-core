import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        subtle: 'var(--subtle)',
        text: 'var(--text)',
        secondary: 'var(--secondary)',
        muted: 'var(--muted)',
        primary: {
          DEFAULT: 'var(--primary)',
          hover: 'var(--primary-hover)',
          soft: 'var(--primary-soft)',
        },
        line: {
          DEFAULT: 'var(--line)',
          strong: 'var(--line-strong)',
        },
        success: { DEFAULT: 'var(--success)', deep: 'var(--success-deep)' },
        warning: { DEFAULT: 'var(--warning)', deep: 'var(--warning-deep)' },
        error: { DEFAULT: 'var(--error)', deep: 'var(--error-deep)' },
        'c-trigger': 'var(--c-trigger)',
        'c-action': 'var(--c-action)',
        'c-condition': 'var(--c-condition)',
        'c-data': 'var(--c-data)',
        'c-ai': 'var(--c-ai)',
        // "Precision Dark" redesign token layer (packages/ui/src/theme.css,
        // html[data-nx-theme] [data-app-theme]) — namespaced under `nx` so
        // these never collide with the existing bg/surface/line/success
        // utilities above. Page-by-page rollout: only the app shell reads
        // these so far.
        'nx-bg': 'var(--nx-bg)',
        'nx-surface': 'var(--nx-surface)',
        'nx-raised': 'var(--nx-raised)',
        'nx-line': {
          DEFAULT: 'var(--nx-line)',
          inner: 'var(--nx-line-inner)',
        },
        'nx-ink': {
          DEFAULT: 'var(--nx-ink)',
          2: 'var(--nx-ink-2)',
          3: 'var(--nx-ink-3)',
          disabled: 'var(--nx-ink-disabled)',
        },
        'nx-blue-panel': { DEFAULT: 'var(--nx-blue-panel)', text: 'var(--nx-blue-panel-text)' },
        'nx-blue-cta': { DEFAULT: 'var(--nx-blue-cta)', text: 'var(--nx-blue-cta-text)' },
        'nx-blue-tint': 'var(--nx-blue-tint)',
        'nx-blue-soft-text': 'var(--nx-blue-soft-text)',
        'nx-warn': 'var(--nx-warn)',
        'nx-danger': {
          DEFAULT: 'var(--nx-danger)',
          text: 'var(--nx-danger-text)',
          tint: 'var(--nx-danger-tint)',
        },
        'nx-success': 'var(--nx-success)',
      },
      fontFamily: {
        sans: ['Satoshi', 'system-ui', '-apple-system', 'sans-serif'],
        'nx-ui': ['var(--nx-font-ui)'],
        'nx-condensed': ['var(--nx-font-condensed)'],
        'nx-mono': ['var(--nx-font-mono)'],
      },
      borderRadius: {
        nx: 'var(--nx-radius)',
      },
      transitionTimingFunction: {
        nx: 'var(--nx-ease)',
      },
    },
  },
  plugins: [],
};

export default config;
