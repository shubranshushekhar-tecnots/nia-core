-- 0075_agent_tasks_read_batch.sql
-- Route 1 integration, Slice T2 ("reading a local database through the
-- bridge" — docs/plans/route1-design.md §3-5): the bridge's internal
-- /execute now dispatches a 'read_batch' task to the agent instead of
-- stubbing out, same connection_id-keyed family as test_connection/
-- list_tables (0072), not the agent_setup_id-keyed family (0074).
--
-- Both widenings below are the same drop+recreate pattern 0074 already
-- used to add its own four kinds, so the existing test_connection/
-- list_tables rows and checks are unaffected.

alter table public.agent_tasks
  drop constraint agent_tasks_kind_check;

alter table public.agent_tasks
  add constraint agent_tasks_kind_check
    check (kind in ('test_connection', 'list_tables', 'read_batch', 'run_now', 'pause', 'resume', 'test_job'));

alter table public.agent_tasks
  drop constraint agent_tasks_connection_xor_setup;

alter table public.agent_tasks
  add constraint agent_tasks_connection_xor_setup check (
    (kind in ('test_connection', 'list_tables', 'read_batch') and connection_id is not null and agent_setup_id is null)
    or (kind in ('run_now', 'pause', 'resume', 'test_job') and agent_setup_id is not null and connection_id is null)
  );

comment on column public.agent_tasks.payload is
  'Kind-specific task body delivered to the agent on its next check-in '
  '(services/agent-bridge/src/app.ts). test_connection/list_tables '
  'carry {localConnectionId}. read_batch carries {localConnectionId, '
  'table, columns, filter, cursor, limit, batchCount, signatureKey} '
  '(services/agent-bridge/src/internalApp.ts) — the agent streams up to '
  'batchCount keyset-paged batches back via POST /agent-api/read-batches '
  'rather than through this row''s result column. run_now carries '
  '{params?, fullReload?, allowMassDelete?}; pause/resume/test_job carry {}.';
