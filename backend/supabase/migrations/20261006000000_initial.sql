-- Integers are values on owned cards, not rows in a pre-generated catalog.
create table public.players (
  user_id uuid primary key references auth.users(id) on delete cascade,
  next_pack_available_at timestamptz,
  distinct_cards integer not null default 0 check (distinct_cards >= 0),
  packs_opened bigint not null default 0 check (packs_opened >= 0)
);

create table public.special_cards (
  id text primary key check (length(id) between 1 and 100),
  label text not null,
  category text not null
);

create table public.collection (
  user_id uuid not null references public.players(user_id) on delete cascade,
  kind text not null check (kind in ('integer', 'special')),
  integer_value text,
  special_id text references public.special_cards(id),
  card_key text generated always as (
    case when kind = 'integer' then 'integer:' || integer_value
         else 'special:' || special_id end
  ) stored,
  quantity bigint not null check (quantity > 0),
  first_collected_at timestamptz not null default now(),
  primary key (user_id, card_key),
  constraint valid_card check (
    (kind = 'integer' and special_id is null and integer_value is not null
      and length(integer_value) <= 200 and integer_value ~ '^(0|-?[1-9][0-9]*)$')
    or (kind = 'special' and integer_value is null and special_id is not null)
  )
);

create table public.opened_packs (
  user_id uuid not null references public.players(user_id) on delete cascade,
  request_id uuid not null,
  opened_at timestamptz not null,
  next_pack_available_at timestamptz not null,
  cards jsonb not null check (jsonb_typeof(cards) = 'array' and jsonb_array_length(cards) = 10),
  primary key (user_id, request_id)
);

alter table public.players enable row level security;
alter table public.special_cards enable row level security;
alter table public.collection enable row level security;
alter table public.opened_packs enable row level security;

revoke all on public.players, public.special_cards, public.collection, public.opened_packs
  from anon, authenticated;
grant select on public.players, public.special_cards, public.collection, public.opened_packs
  to authenticated;
grant all on public.players, public.special_cards, public.collection, public.opened_packs
  to service_role;

create policy own_player on public.players for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_collection on public.collection for select to authenticated
  using (user_id = (select auth.uid()));
create policy own_packs on public.opened_packs for select to authenticated
  using (user_id = (select auth.uid()));
create policy read_special_cards on public.special_cards for select to authenticated
  using (true);

-- Called only by the trusted Edge Function, after verifying the user with Auth.
create function public.ensure_player(p_user_id uuid)
returns public.players
language plpgsql security invoker set search_path = '' as $$
declare v_player public.players;
begin
  insert into public.players(user_id) values (p_user_id) on conflict do nothing;
  select * into v_player from public.players where user_id = p_user_id;
  return v_player;
end;
$$;

create function public.award_pack(
  p_user_id uuid,
  p_request_id uuid,
  p_expected_distinct integer,
  p_cards jsonb
)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_player public.players;
  v_pack public.opened_packs;
  v_card jsonb;
  v_now timestamptz;
begin
  insert into public.players(user_id) values (p_user_id) on conflict do nothing;
  select * into v_player from public.players where user_id = p_user_id for update;

  -- Check retries before cooldown: a lost response must be recoverable.
  select * into v_pack from public.opened_packs
    where user_id = p_user_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('cards', v_pack.cards, 'requestId', v_pack.request_id,
      'openedAt', v_pack.opened_at, 'nextPackAvailableAt', v_pack.next_pack_available_at,
      'replayed', true);
  end if;

  v_now := clock_timestamp();
  if v_player.next_pack_available_at > v_now then
    return jsonb_build_object('error', 'cooldown',
      'nextPackAvailableAt', v_player.next_pack_available_at);
  end if;
  if v_player.distinct_cards <> p_expected_distinct then
    return jsonb_build_object('error', 'progression_changed');
  end if;
  if p_cards is null or jsonb_typeof(p_cards) <> 'array' or jsonb_array_length(p_cards) <> 10 then
    raise exception 'A pack must have exactly ten cards' using errcode = '22023';
  end if;

  for v_card in select value from jsonb_array_elements(p_cards) loop
    if v_card->>'kind' = 'integer' then
      if jsonb_typeof(v_card->'value') is distinct from 'string' then
        raise exception 'Integer values must be decimal strings' using errcode = '22023';
      end if;
      insert into public.collection(user_id, kind, integer_value, quantity, first_collected_at)
        values (p_user_id, 'integer', v_card->>'value', 1, v_now)
        on conflict (user_id, card_key) do update set quantity = public.collection.quantity + 1;
    elsif v_card->>'kind' = 'special' then
      if jsonb_typeof(v_card->'id') is distinct from 'string' then
        raise exception 'Special cards need an ID' using errcode = '22023';
      end if;
      insert into public.collection(user_id, kind, special_id, quantity, first_collected_at)
        values (p_user_id, 'special', v_card->>'id', 1, v_now)
        on conflict (user_id, card_key) do update set quantity = public.collection.quantity + 1;
    else
      raise exception 'Unknown card kind' using errcode = '22023';
    end if;
  end loop;

  insert into public.opened_packs values
    (p_user_id, p_request_id, v_now, v_now + interval '4 hours', p_cards);
  update public.players set
    next_pack_available_at = v_now + interval '4 hours',
    packs_opened = packs_opened + 1,
    distinct_cards = (select count(*) from public.collection where user_id = p_user_id)
    where user_id = p_user_id;
  return jsonb_build_object('cards', p_cards, 'requestId', p_request_id,
    'openedAt', v_now, 'nextPackAvailableAt', v_now + interval '4 hours', 'replayed', false);
end;
$$;

revoke all on function public.ensure_player(uuid) from public, anon, authenticated;
revoke all on function public.award_pack(uuid, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.ensure_player(uuid) to service_role;
grant execute on function public.award_pack(uuid, uuid, integer, jsonb) to service_role;
