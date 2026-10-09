-- First-collected timestamps identify discoveries from this pack, including retries.
create or replace function public.award_pack(
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
  select * into v_player from public.ensure_player(p_user_id);

  -- Check retries before cooldown: a lost response must be recoverable.
  select * into v_pack from public.opened_packs
    where user_id = p_user_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('cards', v_pack.cards, 'requestId', v_pack.request_id,
      'openedAt', v_pack.opened_at, 'nextAllowanceAt', v_pack.next_pack_available_at,
      'packAllowances', v_pack.pack_allowances,
      'replayed', true,
      'newCardKeys', (select coalesce(jsonb_agg(card_key order by card_key), '[]'::jsonb)
        from public.collection where user_id = p_user_id
        and first_collected_at = v_pack.opened_at));
  end if;

  v_now := clock_timestamp();
  if v_player.pack_allowances = 0 then
    return jsonb_build_object('error', 'cooldown',
      'nextAllowanceAt', v_player.next_pack_available_at, 'packAllowances', 0);
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

  -- Spending from a full balance starts a new refill cycle.
  v_player.pack_allowances := v_player.pack_allowances - 1;
  v_player.next_pack_available_at := coalesce(
    v_player.next_pack_available_at, v_now + interval '4 hours');
  insert into public.opened_packs
    (user_id, request_id, opened_at, next_pack_available_at, cards, pack_allowances)
    values (p_user_id, p_request_id, v_now, v_player.next_pack_available_at,
      p_cards, v_player.pack_allowances);
  update public.players set
    next_pack_available_at = v_player.next_pack_available_at,
    pack_allowances = v_player.pack_allowances,
    packs_opened = packs_opened + 1,
    distinct_cards = (select count(*) from public.collection where user_id = p_user_id)
    where user_id = p_user_id;
  return jsonb_build_object('cards', p_cards, 'requestId', p_request_id,
    'openedAt', v_now, 'nextAllowanceAt', v_player.next_pack_available_at,
    'packAllowances', v_player.pack_allowances, 'replayed', false,
    'newCardKeys', (select coalesce(jsonb_agg(card_key order by card_key), '[]'::jsonb)
      from public.collection where user_id = p_user_id
      and first_collected_at = v_now));
end;
$$;

