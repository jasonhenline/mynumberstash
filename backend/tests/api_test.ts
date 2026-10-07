import { assertEquals } from "@std/assert";
import { createGameHandler } from "../supabase/functions/game-api/handler.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const requestId = "10000000-0000-4000-8000-000000000001";
const config = {
  supabaseUrl: "https://example.supabase.co",
  anonKey: "test-public-key",
  serviceRoleKey: "test-server-key",
  allowedOrigins: ["http://localhost:5173"],
};

Deno.test("collection reads use the user's token and return pagination cursors", async () => {
  const handler = createGameHandler(
    config,
    ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user") {
        return Promise.resolve(
          Response.json({ id: userId }),
        );
      }
      assertEquals(url.pathname, "/rest/v1/collection");
      assertEquals(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-user-token",
      );
      assertEquals(url.searchParams.get("user_id"), `eq.${userId}`);
      assertEquals(url.searchParams.get("card_key"), "gt.integer:0");
      assertEquals(url.searchParams.get("limit"), "2");
      return Promise.resolve(Response.json([
        {
          card_key: "integer:1",
          kind: "integer",
          integer_value: "1",
          quantity: 3,
          first_collected_at: "2026-10-06T18:00:00Z",
        },
        {
          card_key: "integer:2",
          kind: "integer",
          integer_value: "2",
          quantity: 1,
          first_collected_at: "2026-10-06T18:00:00Z",
        },
      ]));
    }) as typeof fetch,
  );
  const response = await handler(
    new Request(
      "http://localhost/game-api/collection?limit=1&cursor=integer%3A0",
      {
        headers: { Authorization: "Bearer test-user-token" },
      },
    ),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    cards: [{
      card: { kind: "integer", value: "1" },
      quantity: 3,
      firstCollectedAt: "2026-10-06T18:00:00Z",
    }],
    nextCursor: "integer:1",
  });
});

Deno.test("API rejects missing or invalid sessions before touching the database", async () => {
  let calls = 0;
  const handler = createGameHandler(
    config,
    (() => {
      calls++;
      return Promise.resolve(
        Response.json({ message: "invalid session" }, { status: 401 }),
      );
    }) as typeof fetch,
  );
  assertEquals(
    (await handler(new Request("http://localhost/game-api/me"))).status,
    401,
  );
  assertEquals(calls, 0);
  assertEquals(
    (await handler(
      new Request("http://localhost/game-api/me", {
        headers: { Authorization: "Bearer invalid" },
      }),
    )).status,
    401,
  );
  assertEquals(calls, 1);
});

Deno.test("API supports browser preflight and rejects unconfigured origins", async () => {
  const handler = createGameHandler(
    config,
    (() => {
      throw new Error("Unexpected network call");
    }) as typeof fetch,
  );
  const response = await handler(
    new Request("http://localhost/game-api/me", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    }),
  );
  assertEquals(response.status, 204);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:5173",
  );
  assertEquals(
    (await handler(
      new Request("http://localhost/game-api/me", {
        headers: { Origin: "https://unconfigured.example" },
      }),
    )).status,
    403,
  );
});

Deno.test("pack endpoint uses verified identity, generates cards, and reports cooldown", async () => {
  let awards = 0;
  const handler = createGameHandler(
    config,
    (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/auth/v1/user") return Response.json({ id: userId });
      if (path === "/rest/v1/rpc/ensure_player") {
        assertEquals(await new Response(init?.body).json(), {
          p_user_id: userId,
        });
        return Response.json({
          user_id: userId,
          distinct_cards: 0,
          packs_opened: 0,
          pack_allowances: 1,
          next_pack_available_at: "2026-10-07T22:00:00Z",
        });
      }
      if (path === "/rest/v1/rpc/award_pack") {
        const body = await new Response(init?.body).json();
        assertEquals(body.p_user_id, userId);
        assertEquals(body.p_request_id, requestId);
        assertEquals(body.p_cards.length, 10);
        assertEquals(
          body.p_cards.every((card: { kind: string; value: string }) =>
            card.kind === "integer" && /^(0|[1-9][0-9]*)$/.test(card.value)
          ),
          true,
        );
        awards++;
        return Response.json({
          error: "cooldown",
          nextAllowanceAt: new Date(Date.now() + 60000).toISOString(),
        });
      }
      throw new Error(`Unexpected request path: ${path}`);
    }) as typeof fetch,
  );
  const response = await handler(
    new Request("http://localhost/functions/v1/game-api/packs/open", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-user-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requestId }),
    }),
  );
  assertEquals(response.status, 429);
  assertEquals((await response.json()).error, "cooldown");
  assertEquals(awards, 1);
  const me = await handler(
    new Request("http://localhost/game-api/me", {
      headers: { Authorization: "Bearer test-user-token" },
    }),
  );
  assertEquals(me.status, 200);
  const player = await me.json();
  assertEquals(player.packAllowances, 1);
  assertEquals(player.maxPackAllowances, 6);
  assertEquals(player.nextAllowanceAt, "2026-10-07T22:00:00Z");
});

Deno.test("player status reports specials locked below 100 and unlocked at 100", async () => {
  for (const distinct of [99, 100]) {
    const handler = createGameHandler(
      config,
      ((input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path === "/auth/v1/user") {
          return Promise.resolve(Response.json({ id: userId }));
        }
        assertEquals(path, "/rest/v1/rpc/ensure_player");
        return Promise.resolve(Response.json({
          distinct_cards: distinct,
          packs_opened: 10,
          pack_allowances: 2,
          next_pack_available_at: "2026-10-07T22:00:00Z",
        }));
      }) as typeof fetch,
    );
    const response = await handler(
      new Request("http://localhost/game-api/me", {
        headers: { Authorization: "Bearer test-user-token" },
      }),
    );
    assertEquals(response.status, 200);
    const player = await response.json();
    assertEquals(player.specialsUnlocked, distinct >= 100);
    assertEquals(player.negativesUnlocked, true);
  }
});
