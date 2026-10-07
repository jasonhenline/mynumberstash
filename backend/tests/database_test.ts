import { PGlite } from "@electric-sql/pglite";
import { assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";

// Run real Postgres SQL in memory; Supabase's auth schema/roles are stubbed here.
// This verifies transactions and permissions, but not multi-connection locking.
Deno.test("pack awards are atomic, retry-safe, cooldown-enforced, and protected by RLS", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as
        'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
      grant usage on schema public, auth to anon, authenticated, service_role;
      grant execute on function auth.uid() to authenticated;
      insert into auth.users values
        ('00000000-0000-4000-8000-000000000001'),
        ('00000000-0000-4000-8000-000000000002');
    `);
    await db.exec(
      await Deno.readTextFile(
        new URL(
          "../supabase/migrations/20261006000000_initial.sql",
          import.meta.url,
        ),
      ),
    );
    await db.exec(
      await Deno.readTextFile(
        new URL(
          "../supabase/migrations/20261007000000_pack_allowances.sql",
          import.meta.url,
        ),
      ),
    );
    await db.exec(
      await Deno.readTextFile(
        new URL(
          "../supabase/migrations/20261007010000_pi_card.sql",
          import.meta.url,
        ),
      ),
    );
    assertEquals(
      (await db.query("select id, label from public.special_cards")).rows,
      [{ id: "pi", label: "π" }],
    );
    await db.exec(
      await Deno.readTextFile(
        new URL(
          "../supabase/migrations/20261007020000_more_special_cards.sql",
          import.meta.url,
        ),
      ),
    );
    assertEquals(
      (await db.query("select id, label from public.special_cards order by id"))
        .rows,
      [
        { id: "e", label: "e" },
        { id: "i", label: "i" },
        { id: "phi", label: "φ" },
        { id: "pi", label: "π" },
        { id: "sqrt2", label: "√2" },
      ],
    );
    const user = "00000000-0000-4000-8000-000000000001";
    const other = "00000000-0000-4000-8000-000000000002";
    const id = "10000000-0000-4000-8000-000000000001";
    const secondId = "10000000-0000-4000-8000-000000000002";
    const cards = Array(10).fill({ kind: "integer", value: "0" });
    const award = async (requestId: string, values = cards, expected = 0) => {
      const result = await db.query<{ pack: Record<string, unknown> }>(
        "select public.award_pack($1, $2, $3, $4::jsonb) as pack",
        [user, requestId, expected, JSON.stringify(values)],
      );
      return result.rows[0].pack;
    };
    await db.exec("set role service_role");
    const first = await award(id);
    assertEquals(first.replayed, false);
    assertEquals(first.cards, cards);
    assertEquals(first.packAllowances, 0);
    assertAlmostEquals(
      Date.parse(first.nextAllowanceAt as string) -
        Date.parse(first.openedAt as string),
      4 * 60 * 60 * 1000,
      1000,
    );
    assertEquals((await award(id)).replayed, true);
    assertEquals((await award(secondId)).error, "cooldown");
    assertEquals(
      (await db.query("select quantity from public.collection")).rows,
      [{ quantity: 10 }],
    );
    assertEquals(
      (await db.query(
        "select distinct_cards, packs_opened from public.players",
      )).rows,
      [{ distinct_cards: 1, packs_opened: 1 }],
    );

    await db.exec(
      "update public.players set next_pack_available_at = clock_timestamp() - interval '1 second'",
    );
    assertEquals(
      (await award(secondId, cards, 0)).error,
      "progression_changed",
    );
    const malformed = [...cards];
    malformed[9] = { kind: "integer", value: "01" };
    await assertRejects(() => award(secondId, malformed, 1));
    assertEquals(
      (await db.query(
        "select pack_allowances from public.players where user_id = $1",
        [user],
      )).rows,
      [{ pack_allowances: 1 }],
    );
    assertEquals(
      (await db.query("select quantity from public.collection")).rows,
      [{ quantity: 10 }],
    );
    assertEquals(
      (await db.query("select count(*)::int as n from public.opened_packs"))
        .rows,
      [{ n: 1 }],
    );
    const large = [...cards];
    large[0] = { kind: "integer", value: "123456789012345678901234567890" };
    const second = await award(secondId, large, 1);
    assertEquals(second.replayed, false);
    assertEquals(
      (await db.query("select distinct_cards from public.players")).rows,
      [{ distinct_cards: 2 }],
    );
    await db.query("select public.ensure_player($1)", [other]);

    // Special cards need an existing definition, and a failed FK rolls back the award.
    const specialRequest = "10000000-0000-4000-8000-000000000003";
    const specialCards = Array(10).fill({ kind: "special", id: "pi" });
    await db.exec(
      "update public.players set pack_allowances = 6, next_pack_available_at = null",
    );
    await assertRejects(() =>
      db.query(
        "select public.award_pack($1, $2, 2, $3::jsonb)",
        [
          user,
          specialRequest,
          JSON.stringify(Array(10).fill({ kind: "special", id: "missing" })),
        ],
      )
    );
    await db.query("select public.award_pack($1, $2, 2, $3::jsonb)", [
      user,
      specialRequest,
      JSON.stringify(specialCards),
    ]);
    assertEquals(
      (await db.query(
        "select quantity from public.collection where special_id = 'pi'",
      )).rows,
      [{ quantity: 10 }],
    );

    // Thirteen hours from an empty balance yields three packs, with three hours left.
    await db.query(
      `update public.players set pack_allowances = 0,
      next_pack_available_at = clock_timestamp() - interval '9 hours' where user_id = $1`,
      [user],
    );
    const refilled = (await db.query<
      { player: { pack_allowances: number; next_pack_available_at: string } }
    >(
      "select to_jsonb(public.ensure_player($1)) as player",
      [user],
    )).rows[0].player;
    assertEquals(refilled.pack_allowances, 3);
    assertAlmostEquals(
      Date.parse(refilled.next_pack_available_at) - Date.now(),
      3 * 3600000,
      2000,
    );
    for (let i = 0; i < 3; i++) {
      const opened = await award(
        `20000000-0000-4000-8000-00000000000${i}`,
        cards,
        3,
      );
      assertEquals(opened.packAllowances, 2 - i);
      assertEquals(opened.nextAllowanceAt, refilled.next_pack_available_at);
    }
    assertEquals(
      (await award("20000000-0000-4000-8000-000000000009", cards, 3)).error,
      "cooldown",
    );

    // Exact refill boundary is included; full balances discard surplus time.
    await db.query(
      `update public.players set pack_allowances = 0,
      next_pack_available_at = clock_timestamp() where user_id = $1`,
      [user],
    );
    const boundary = (await db.query<{ player: { pack_allowances: number } }>(
      "select to_jsonb(public.ensure_player($1)) as player",
      [user],
    )).rows[0].player;
    assertEquals(boundary.pack_allowances, 1);
    await db.query(
      `update public.players set pack_allowances = 0,
      next_pack_available_at = clock_timestamp() - interval '10 days' where user_id = $1`,
      [user],
    );
    const capped = (await db.query<
      { player: { pack_allowances: number; next_pack_available_at: null } }
    >(
      "select to_jsonb(public.ensure_player($1)) as player",
      [user],
    )).rows[0].player;
    assertEquals(capped.pack_allowances, 6);
    assertEquals(capped.next_pack_available_at, null);
    const fromFull = await award(
      "30000000-0000-4000-8000-000000000001",
      cards,
      3,
    );
    assertEquals(fromFull.packAllowances, 5);
    assertAlmostEquals(
      Date.parse(fromFull.nextAllowanceAt as string) -
        Date.parse(fromFull.openedAt as string),
      4 * 3600000,
      1000,
    );
    assertEquals(
      (await award("30000000-0000-4000-8000-000000000001", cards, 3)).replayed,
      true,
    );
    assertEquals(
      (await db.query(
        "select pack_allowances from public.players where user_id = $1",
        [user],
      )).rows,
      [{ pack_allowances: 5 }],
    );

    await db.exec("reset role; set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      other,
    ]);
    assertEquals((await db.query("select * from public.collection")).rows, []);
    assertEquals(
      (await db.query("select * from public.opened_packs")).rows,
      [],
    );
    await assertRejects(() => award(secondId));
    await assertRejects(() =>
      db.exec("update public.players set distinct_cards = 100")
    );
    await assertRejects(() =>
      db.exec("insert into public.special_cards values ('pi', 'π', 'constant')")
    );
    await db.exec("reset role; set role anon");
    await assertRejects(() => db.exec("select * from public.collection"));
  } finally {
    await db.close();
  }
});
