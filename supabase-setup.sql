-- Trading Hub — Supabase journal_entries table
-- Run this once in your Supabase project's SQL editor at:
--   https://supabase.com/dashboard → your project → SQL Editor

create table if not exists journal_entries (
    id                   bigint primary key,
    user_id              uuid references auth.users not null,
    date                 text,
    ticker               text,
    type                 text default 'CALL',
    strike               text,
    exp                  text,
    qty                  integer default 1,
    entry                numeric,
    exit                 numeric,
    status               text default 'Open',
    thesis               text,
    recommendation       text,
    recommendation_reason text,
    rating               text,
    action               text,
    current_price        numeric,
    price_change         numeric,
    news_summary         text,
    last_checked         text,
    entry_low            numeric,
    entry_high           numeric,
    stop_loss            numeric,
    target               numeric,
    option_detail        text,
    account_sizing       text,
    stock_price_at_entry numeric,
    option_type          text,
    created_at           timestamptz default now()
);

-- Row Level Security: each user can only see/edit their own trades
alter table journal_entries enable row level security;

create policy "Users manage their own trades"
    on journal_entries
    for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
