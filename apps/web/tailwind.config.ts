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
      },
      fontFamily: {
        sans: ['Satoshi', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
