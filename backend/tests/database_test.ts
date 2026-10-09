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
    await db.exec(
      await Deno.readTextFile(
        new URL(
          "../supabase/migrations/20261009000000_pack_discoveries.sql",
          import.meta.url,
        ),
      ),
    );
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
    assertEquals(first.newCardKeys, ["integer:0"]);
    assertEquals(first.packAllowances, 0);
    assertAlmostEquals(
      Date.parse(first.nextAllowanceAt as string) -
        Date.parse(first.openedAt as string),
      4 * 60 * 60 * 1000,
      1000,
    );
    const recovered = await award(id);
    assertEquals(recovered.replayed, true);
    assertEquals(recovered.newCardKeys, first.newCardKeys);
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
    assertEquals(second.newCardKeys, [
      "integer:123456789012345678901234567890",
    ]);
    assertEquals((await award(id)).newCardKeys, ["integer:0"]);
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
    const specialAward = await db.query<{ pack: { newCardKeys: string[] } }>(
      "select public.award_pack($1, $2, 2, $3::jsonb) as pack",
      [
        user,
        specialRequest,
        JSON.stringify(specialCards),
      ],
    );
    assertEquals(specialAward.rows[0].pack.newCardKeys, ["special:pi"]);
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

Deno.test("album pages preserve integer boundaries, huge values, special labels, and RLS", async () => {
  const db = new PGlite();
  const user = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  const huge = String(10n ** 120n + 123n);
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as
        'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
      grant usage on schema public, auth to anon, authenticated, service_role;
      grant execute on function auth.uid() to authenticated;
      insert into auth.users values ('${user}'), ('${other}');
    `);
    for (
      const name of [
        "20261006000000_initial.sql",
        "20261007000000_pack_allowances.sql",
        "20261007010000_pi_card.sql",
        "20261007020000_more_special_cards.sql",
        "20261007030000_integer_album.sql",
        "20261008000000_collection_snapshot.sql",
      ]
    ) {
      await db.exec(
        await Deno.readTextFile(
          new URL(`../supabase/migrations/${name}`, import.meta.url),
        ),
      );
    }
    await db.exec("set role service_role");
    await db.query("select public.ensure_player($1)", [user]);
    for (
      const value of [
        "-101",
        "-100",
        "-1",
        "0",
        "99",
        "100",
        "199",
        "200",
        huge,
      ]
    ) {
      await db.query(
        "insert into public.collection(user_id, kind, integer_value, quantity) values ($1, 'integer', $2, 2)",
        [user, value],
      );
    }
    await db.query(
      "insert into public.collection(user_id, kind, special_id, quantity) values ($1, 'special', 'phi', 3)",
      [user],
    );
    await db.exec("reset role; set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      user,
    ]);
    const read = async (page: string) =>
      (await db.query<{
        album: {
          page: string;
          minPage: string;
          maxPage: string;
          cards: { card: { kind: string; value: string }; quantity: number }[];
          specials: unknown[];
        };
      }>("select public.collection_album($1) as album", [page])).rows[0].album;
    const zero = await read("0");
    assertEquals(zero.minPage, "-2");
    assertEquals(zero.maxPage, String(BigInt(huge) / 100n));
    assertEquals(zero.cards, [{
      card: { kind: "integer", value: "0" },
      quantity: 2,
    }, { card: { kind: "integer", value: "99" }, quantity: 2 }]);
    assertEquals(zero.specials, [{
      card: { kind: "special", id: "phi", label: "φ" },
      quantity: 3,
    }]);
    assertEquals((await read("-1")).cards.map((item) => item.card.value), [
      "-100",
      "-1",
    ]);
    assertEquals((await read("-2")).cards.map((item) => item.card.value), [
      "-101",
    ]);
    assertEquals((await read("1")).cards.map((item) => item.card.value), [
      "100",
      "199",
    ]);
    assertEquals((await read("2")).cards.map((item) => item.card.value), [
      "200",
    ]);
    assertEquals(
      (await read(String(BigInt(huge) / 100n))).cards[0].card.value,
      huge,
    );
    assertEquals((await read("-999")).page, "-2");
    const snapshot = async () =>
      (await db.query<{
        stash: {
          cards: {
            card: { kind: string; value?: string; id?: string; label?: string };
            quantity: number;
          }[];
        };
      }>("select public.collection_snapshot() as stash")).rows[0].stash;
    const all = await snapshot();
    assertEquals(all.cards.length, 10);
    assertEquals(
      all.cards.find((item) => item.card.value === huge)?.quantity,
      2,
    );
    assertEquals(all.cards.find((item) => item.card.id === "phi"), {
      card: { kind: "special", id: "phi", label: "φ" },
      quantity: 3,
    });
    // A scalar JSON result includes every card, even beyond the API's row limit.
    await db.exec("reset role; set role service_role");
    await db.query(
      "insert into public.collection(user_id, kind, integer_value, quantity) select $1, 'integer', n::text, 1 from generate_series(1000, 2199) n",
      [user],
    );
    await db.exec("reset role; set role authenticated");
    assertEquals((await snapshot()).cards.length, 1210);
    for (const invalid of ["01", "-0", "1.5", "abc", "9".repeat(201)]) {
      await assertRejects(() => read(invalid));
    }
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      other,
    ]);
    assertEquals(await read("999"), {
      page: "0",
      minPage: "0",
      maxPage: "0",
      cards: [],
      specials: [],
    });
    assertEquals(await snapshot(), { cards: [] });
    await db.exec("reset role; set role anon");
    await assertRejects(() => read("0"));
    await assertRejects(snapshot);
  } finally {
    await db.close();
  }
});
