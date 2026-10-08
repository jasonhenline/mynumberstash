-- Aggregate in Postgres so the full collection is not truncated by API row limits.
create function public.collection_snapshot()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_cards jsonb;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'card', case when c.kind = 'integer'
      then jsonb_build_object('kind', 'integer', 'value', c.integer_value)
      else jsonb_build_object('kind', 'special', 'id', c.special_id, 'label', s.label)
      end,
    'quantity', c.quantity) order by c.card_key), '[]'::jsonb)
    into v_cards from public.collection c
    left join public.special_cards s on s.id = c.special_id
    where c.user_id = v_user;
  return jsonb_build_object('cards', v_cards);
end;
$$;
revoke all on function public.collection_snapshot() from public, anon;
grant execute on function public.collection_snapshot() to authenticated;
