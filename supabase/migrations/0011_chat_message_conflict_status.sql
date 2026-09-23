-- 0011_chat_message_conflict_status.sql
-- Adds 'conflict' to public.chat_message_status. 0010 only modeled 3 of the
-- 4 terminal ChatStreamEvent kinds (done -> complete, refused -> refused,
-- error -> error) and missed multi-source's `conflict` event (a reduction
-- tie, e.g. two flavours exactly tied for MAX revenue) — that terminal
-- state is distinct from a normal error (nothing crashed, the sources just
-- didn't converge to a single answer) and from a refusal (the request
-- shape was fine), so it gets its own status rather than being folded into
-- 'error'. Split into its own migration, not amended into 0010, because
-- Postgres forbids using a newly-added enum value inside the same
-- transaction that added it (same rationale as 0003_owner_enum_value.sql).

alter type public.chat_message_status add value if not exists 'conflict';
