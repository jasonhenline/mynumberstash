import { PGlite } from "@electric-sql/pglite";
import { assertEquals, assertRejects } from "@std/assert";

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
    assertEquals(
      Date.parse(first.nextPackAvailableAt as string) -
        Date.parse(first.openedAt as string),
      4 * 60 * 60 * 1000,
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
    await db.exec("update public.players set next_pack_available_at = null");
    await assertRejects(() =>
      db.query(
        "select public.award_pack($1, $2, 2, $3::jsonb)",
        [user, specialRequest, JSON.stringify(specialCards)],
      )
    );
    await db.exec(
      "insert into public.special_cards values ('pi', 'π', 'constant')",
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
