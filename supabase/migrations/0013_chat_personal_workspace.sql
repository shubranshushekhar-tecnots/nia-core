-- 0013_chat_personal_workspace.sql
-- Opens chat up to org-less "individual" actors, same XOR org/owner pattern
-- as 0005_individual_workspace.sql (projects/workflows/workflow_runs) and
-- 0007_connectors.sql (connections/connector_installs/audit_log) — 0010's
-- header comment explicitly anticipated this migration. org_id becomes
-- nullable on both conversations and messages, a new owner_id column
-- carries personal ownership, and a check constraint enforces exactly one
-- of (org_id, owner_id) is set. Every policy below is recreated with an
-- added OR-branch for personally-owned rows; the org-branch conditions are
-- byte-for-byte identical to 0010's originals.
--
-- Additive/reversible: no column dropped/renamed, no existing row's org_id
-- touched (every pre-existing row already satisfies "org_id is not null"
-- so trivially satisfies the new check constraint). Rollback: drop the two
-- check constraints, drop the two owner_id columns, recreate the policies
-- below with the personal-ownership OR-branch removed.

-- =========================================================================
-- 1. conversations
-- =========================================================================

alter table public.conversations alter column org_id drop not null;
alter table public.conversations add column owner_id uuid references auth.users (id);

alter table public.conversations add constraint conversations_org_xor_owner check (
  (org_id is not null and owner_id is null) or (org_id is null and owner_id is not null)
);

create index conversations_owner_id_updated_at_idx
  on public.conversations (owner_id, updated_at desc);

drop policy "conversations_select_members" on public.conversations;
create policy "conversations_select_members"
  on public.conversations for select
  using (
    (org_id is not null and private.is_member(org_id))
    or (org_id is null and owner_id = auth.uid())
  );

drop policy "conversations_insert_members" on public.conversations;
create policy "conversations_insert_members"
  on public.conversations for insert
  with check (
    created_by = auth.uid()
    and (
      (org_id is not null and owner_id is null and private.is_member(org_id))
      or (org_id is null and owner_id = auth.uid())
    )
  );

drop policy "conversations_update_own" on public.conversations;
create policy "conversations_update_own"
  on public.conversations for update
  using (
    (org_id is not null and private.is_member(org_id) and created_by = auth.uid())
    or (org_id is null and owner_id = auth.uid() and created_by = auth.uid())
  )
  with check (
    (org_id is not null and private.is_member(org_id) and created_by = auth.uid())
    or (org_id is null and owner_id = auth.uid() and created_by = auth.uid())
  );

-- =========================================================================
-- 2. messages
-- =========================================================================

alter table public.messages alter column org_id drop not null;
alter table public.messages add column owner_id uuid references auth.users (id);

alter table public.messages add constraint messages_org_xor_owner check (
  (org_id is not null and owner_id is null) or (org_id is null and owner_id is not null)
);

create index messages_owner_id_created_at_idx
  on public.messages (owner_id, created_at);

drop policy "messages_select_members" on public.messages;
create policy "messages_select_members"
  on public.messages for select
  using (
    (
      org_id is not null
      and private.is_member(org_id)
      and exists (
        select 1 from public.conversations c
        where c.id = conversation_id and c.org_id = messages.org_id
      )
    )
    or (
      org_id is null
      and owner_id = auth.uid()
      and exists (
        select 1 from public.conversations c
        where c.id = conversation_id and c.owner_id = messages.owner_id
      )
    )
  );

drop policy "messages_insert_own_user_messages" on public.messages;
create policy "messages_insert_own_user_messages"
  on public.messages for insert
  with check (
    role = 'user'
    and (
      (
        org_id is not null
        and private.is_member(org_id)
        and exists (
          select 1 from public.conversations c
          where c.id = conversation_id
            and c.org_id = messages.org_id
            and c.created_by = auth.uid()
        )
      )
      or (
        org_id is null
        and owner_id = auth.uid()
        and exists (
          select 1 from public.conversations c
          where c.id = conversation_id
            and c.owner_id = messages.owner_id
            and c.created_by = auth.uid()
        )
      )
    )
  );
