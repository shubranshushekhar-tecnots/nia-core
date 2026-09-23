-- 0015_conversation_workflow_link.sql
-- Links a conversation to the workflow it was asked from (canvas command
-- bar, Phase 5 Session 4), so reopening a workflow can restore its chat
-- thread. Plain nullable FK, no RLS change: access still resolves via
-- conversations' existing org/owner XOR policies (0010 + 0013) — same
-- pattern workflow_check_runs.workflow_id (0014) uses for a pointer column
-- with no RLS of its own.
--
-- Additive/reversible: nullable column, ON DELETE SET NULL (a deleted
-- workflow never cascades into losing a conversation's messages). Rollback:
-- drop the index, drop the column.

alter table public.conversations
  add column workflow_id uuid references public.workflows (id) on delete set null;

create index conversations_workflow_id_updated_at_idx
  on public.conversations (workflow_id, updated_at desc);
