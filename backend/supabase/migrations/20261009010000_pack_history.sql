-- Read-only history under the player's normal RLS policies.
create function public.pack_history(p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_offset is null or p_offset < 0 then
    raise exception 'Invalid history offset' using errcode = '22023';
  end if;
  with recent as (
    select * from public.opened_packs where user_id = v_user
      order by opened_at desc, request_id desc offset p_offset limit 21
  ), visible as (
    select * from recent order by opened_at desc, request_id desc limit 20
  )
  select jsonb_build_object(
    'packs', coalesce((select jsonb_agg(jsonb_build_object(
      'requestId', p.request_id, 'openedAt', p.opened_at,
      'cards', (select jsonb_agg(
        case when c.value->>'kind' = 'special'
          then c.value || jsonb_build_object('label', coalesce(c.value->>'label', s.label))
          else c.value end order by c.ordinality)
        from jsonb_array_elements(p.cards) with ordinality c
        left join public.special_cards s on s.id = c.value->>'id'),
      'newCardKeys', (select coalesce(jsonb_agg(card_key order by card_key), '[]'::jsonb)
        from public.collection where user_id = v_user and first_collected_at = p.opened_at)
    ) order by p.opened_at desc, p.request_id desc) from visible p), '[]'::jsonb),
    'nextOffset', case when (select count(*) from recent) > 20 then p_offset + 20 else null end
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.pack_history(integer) from public, anon;
grant execute on function public.pack_history(integer) to authenticated;
