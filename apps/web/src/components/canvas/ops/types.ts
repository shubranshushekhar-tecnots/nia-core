import type { OpKind, TransformStep } from '@nia/schemas';
import type { ComponentType } from 'react';

/**
 * Editor descriptor registry, keyed by a type derived from @nia/schemas'
 * OpKind — a missing entry for a new op is a compile error in apps/web,
 * not a silent gap. Deliberately lives here (not in packages/schemas) so
 * that package stays free of React.
 */
export type OpEditorRegistry = {
  [K in OpKind]: {
    label: string;
    Component: ComponentType<{
      step: Extract<TransformStep, { kind: K }>;
      fields: string[];
      onChange: (next: Extract<TransformStep, { kind: K }>) => void;
    }>;
  };
};
