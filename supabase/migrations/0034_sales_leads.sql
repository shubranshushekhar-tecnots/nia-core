-- 0034_sales_leads.sql
-- "Talk to sales" landing page form (apps/web CtaBand.tsx). Public,
-- unauthenticated submissions -- anon/authenticated may INSERT only, never
-- SELECT/UPDATE/DELETE (leads are read via the Supabase dashboard /
-- service_role, not through the app).

create table public.sales_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  work_email text not null,
  company text not null,
  team_size text,
  message text,
  created_at timestamptz not null default now()
);

alter table public.sales_leads enable row level security;

create policy sales_leads_insert on public.sales_leads
  for insert
  to anon, authenticated
  with check (true);
