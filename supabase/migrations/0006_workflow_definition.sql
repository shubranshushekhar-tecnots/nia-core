-- 0006_workflow_definition.sql
-- Adds a `definition` jsonb column to workflows to persist the ETL canvas
-- (nodes + wires) built in the workflow builder UI. Additive only: existing
-- rows default to an empty canvas, no existing column/policy changes. The
-- existing workflows_select_members / workflows_update_members RLS policies
-- (0002 + 0005) already cover reads/writes of this new column — it's just
-- another column on the same row, no new policy needed.

alter table public.workflows
  add column definition jsonb not null default '{"nodes": [], "wires": []}'::jsonb;
