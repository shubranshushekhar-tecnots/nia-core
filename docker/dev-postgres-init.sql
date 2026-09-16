-- Runs automatically on first boot of the dev-postgres scratch container
-- (mounted at /docker-entrypoint-initdb.d — see docker-compose.yml).
-- Seeds a small table and provisions the actual read-only role
-- (nia_ro) that connector-supabase is meant to connect as, so the
-- "read-only role is the real boundary" claim (see contract.ts's
-- ConnectorConfig TODO and guardrails/sql/validator.ts's module header)
-- is something you can actually connect through and test locally, not
-- just a documented convention nobody exercises.

create table if not exists sandbox_items (
  id serial primary key,
  name text not null
);

insert into sandbox_items (name)
values ('seed-1'), ('seed-2')
on conflict do nothing;

-- Gives the chat pipeline's live smoke test (apps/worker/scripts/chat-smoke.ts)
-- something concrete to query and cite ("who has the highest salary?").
create table if not exists employees (
  id serial primary key,
  name text not null,
  salary integer not null
);

insert into employees (name, salary)
values ('Ada Lovelace', 145000), ('Grace Hopper', 162000), ('Alan Turing', 158000)
on conflict do nothing;

create role nia_ro with login password 'nia_ro_pw';
grant connect on database sandbox to nia_ro;
grant usage on schema public to nia_ro;
grant select on all tables in schema public to nia_ro;
-- Covers tables created after this script runs too, not just sandbox_items.
alter default privileges in schema public grant select on tables to nia_ro;
