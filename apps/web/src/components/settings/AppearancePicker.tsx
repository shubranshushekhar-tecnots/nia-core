'use client';

import { useTheme } from 'next-themes';
import {
  nxSettingsAppearanceCardStyle,
  nxSettingsAppearanceGridStyle,
  nxSettingsAppearanceHelperStyle,
  nxSettingsAppearanceLabelStyle,
  nxSettingsAppearanceSwatchStyle,
} from './styles';

// Settings page (Phase 1) — large 3-card picker. Reads/writes the exact
// same next-themes "nia-theme" state as the Sidebar's compact ThemeSwitcher
// dropdown (components/app/ThemeSwitcher.tsx), so the two stay in sync
// automatically with no extra wiring: whichever one is touched last wins,
// and the other reflects it on its next render.
const OPTIONS = [
  { value: 'dark', label: 'DARK', swatch: 'linear-gradient(135deg, #0A0A0B 50%, #F2F2F2 50%)' },
  { value: 'light', label: 'LIGHT', swatch: 'linear-gradient(135deg, #FAFAF8 50%, #0A0A0B 50%)' },
  { value: 'system', label: 'SYSTEM', swatch: 'linear-gradient(135deg, #0A0A0B 50%, #FAFAF8 50%)' },
] as const;

type ThemeValue = (typeof OPTIONS)[number]['value'];

export default function AppearancePicker() {
  const { theme, setTheme } = useTheme();
  const active: ThemeValue = (theme as ThemeValue) ?? 'dark';

  return (
    <div>
      <div role="radiogroup" aria-label="Theme" style={nxSettingsAppearanceGridStyle}>
        {OPTIONS.map((opt) => {
          const selected = opt.value === active;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              style={nxSettingsAppearanceCardStyle(selected)}
              onClick={() => setTheme(opt.value)}
            >
              <span aria-hidden style={nxSettingsAppearanceSwatchStyle(opt.swatch)} />
              <span style={nxSettingsAppearanceLabelStyle(selected)}>{opt.label}</span>
            </button>
          );
        })}
      </div>
      <p style={{ ...nxSettingsAppearanceHelperStyle, marginTop: 10 }}>System follows your OS setting.</p>
    </div>
  );
}
