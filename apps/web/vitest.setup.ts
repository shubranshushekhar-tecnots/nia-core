// Only loaded for the jsdom component-rendering tests (see vitest.config.ts's
// environmentMatchGlobs) — adds jest-dom's DOM matchers (toBeInTheDocument,
// toBeChecked, etc.) on top of vitest's own `expect`.
import '@testing-library/jest-dom/vitest';
