-- Exact page boundaries, including -100..-1, without floating-point conversion.
alter table public.collection add column integer_page numeric generated always as (
  case when kind = 'integer' then floor(integer_value::numeric / 100) end
) stored;
create index collection_integer_page on public.collection(user_id, integer_page)
  where kind = 'integer';

-- Called using the player's authenticated client; normal collection RLS applies.
create function public.collection_album(p_page text default '0')
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_page numeric;
  v_min numeric;
  v_max numeric;
  v_cards jsonb;
  v_specials jsonb;
begin
  if v_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_page is null or length(p_page) > 200 or p_page !~ '^(0|-?[1-9][0-9]*)$' then
    raise exception 'Invalid album page' using errcode = '22023';
  end if;
  select least(0, coalesce(min(integer_page), 0)),
         greatest(0, coalesce(max(integer_page), 0)) into v_min, v_max
    from public.collection where user_id = v_user and kind = 'integer';
  v_page := greatest(v_min, least(v_max, p_page::numeric));
  select coalesce(jsonb_agg(jsonb_build_object(
    'card', jsonb_build_object('kind', 'integer', 'value', integer_value),
    'quantity', quantity) order by integer_value::numeric), '[]'::jsonb)
    into v_cards from public.collection
    where user_id = v_user and kind = 'integer' and integer_page = v_page;
  select coalesce(jsonb_agg(jsonb_build_object(
    'card', jsonb_build_object('kind', 'special', 'id', c.special_id, 'label', s.label),
    'quantity', c.quantity) order by c.special_id), '[]'::jsonb)
    into v_specials from public.collection c
    join public.special_cards s on s.id = c.special_id
    where c.user_id = v_user and c.kind = 'special';
  return jsonb_build_object('page', v_page::text, 'minPage', v_min::text,
    'maxPage', v_max::text, 'cards', v_cards, 'specials', v_specials);
end;
$$;
revoke all on function public.collection_album(text) from public, anon;
grant execute on function public.collection_album(text) to authenticated;
