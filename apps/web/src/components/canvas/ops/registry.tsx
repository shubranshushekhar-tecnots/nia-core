import type { OpEditorRegistry } from './types';
import { FilterStepEditor } from './FilterStepEditor';
import { ComputedFieldStepEditor } from './ComputedFieldStepEditor';
import { DropFieldsStepEditor } from './DropFieldsStepEditor';
import { AggregateStepEditor } from './AggregateStepEditor';

export const OP_EDITOR_REGISTRY: OpEditorRegistry = {
  filter: { label: 'Filter', Component: FilterStepEditor },
  computed_field: { label: 'Computed field', Component: ComputedFieldStepEditor },
  drop_fields: { label: 'Drop fields', Component: DropFieldsStepEditor },
  aggregate: { label: 'Aggregate', Component: AggregateStepEditor },
};
