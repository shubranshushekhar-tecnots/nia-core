-- 0010_chat_conversations.sql
-- Chat history: conversations + messages. Org-scoped only (no owner_id/
-- individual-workspace branch like projects/connections) because chat
-- currently requires an org end-to-end — apps/api's chatRouter runs
-- requireOrgActor ahead of every route, so an org-less "individual" actor
-- can never reach POST /chat in the first place. Add an owner_id xor
-- branch later if/when chat opens up to org-less users, same pattern as
-- 0005_individual_workspace.sql / 0007_connectors.sql.

-- =========================================================================
-- 1. conversations
-- =========================================================================

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid not null references auth.users (id),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_org_id_updated_at_idx
  on public.conversations (org_id, updated_at desc);

alter table public.conversations enable row level security;

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row
  execute function public.set_updated_at();

create policy "conversations_select_members"
  on public.conversations for select
  using (private.is_member(org_id));

create policy "conversations_insert_members"
  on public.conversations for insert
  with check (private.is_member(org_id) and created_by = auth.uid());

-- Unlike projects/workflows (any member can rename), a chat thread isn't a
-- shared team artifact other members should be able to retitle — update
-- (rename) is restricted to the conversation's own creator.
create policy "conversations_update_own"
  on public.conversations for update
  using (private.is_member(org_id) and created_by = auth.uid())
  with check (private.is_member(org_id) and created_by = auth.uid());

grant select, insert, update on public.conversations to authenticated;

-- =========================================================================
-- 2. messages
-- =========================================================================

create type public.chat_message_role as enum ('user', 'assistant');
create type public.chat_message_status as enum ('complete', 'refused', 'error');

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- Denormalized from conversations.org_id so RLS doesn't need a join on
  -- every row check — same rationale as workflows.org_id.
  org_id uuid not null references public.organizations (id) on delete cascade,
  role public.chat_message_role not null,
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  status public.chat_message_status not null default 'complete',
  created_at timestamptz not null default now()
);

create index messages_conversation_id_created_at_idx
  on public.messages (conversation_id, created_at);

alter table public.messages enable row level security;

-- Org membership is the sole visibility gate, matching every other
-- workspace-scoped table (projects, workflows, connections) — any member
-- can read any conversation's messages, not just the conversation's
-- creator. The exists() against conversations is defense-in-depth
-- (confirms org_id wasn't spoofed past the FK), not a narrower
-- "participant" table — there isn't one.
create policy "messages_select_members"
  on public.messages for select
  using (
    private.is_member(org_id)
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.org_id = messages.org_id
    )
  );

-- Client can only ever insert role='user' rows, and only into a
-- conversation it created, in its own org. role='assistant' rows are
-- written exclusively by the worker via the service_role key (bypasses
-- RLS entirely, needs no policy of its own) once a stream's
-- done/refused/error terminal event fires — role='user' is hard-required
-- in the check below, not just left to convention, so no authenticated
-- client can ever insert an assistant-authored row.
create policy "messages_insert_own_user_messages"
  on public.messages for insert
  with check (
    role = 'user'
    and private.is_member(org_id)
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and c.org_id = messages.org_id
        and c.created_by = auth.uid()
    )
  );

grant select, insert on public.messages to authenticated;
