import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { GAME_RULES, generatePack } from "../_shared/cards.ts";
import { HttpError, readRequestId } from "../_shared/http.ts";

export function createGameHandler(
  config: {
    supabaseUrl: string;
    anonKey: string;
    serviceRoleKey: string;
    allowedOrigins: string[];
  },
  fetcher: typeof fetch = fetch,
): (request: Request) => Promise<Response> {
  const { supabaseUrl, anonKey, serviceRoleKey } = config;
  const allowedOrigins = new Set(config.allowedOrigins);
  const clientOptions = {
    auth: { persistSession: false, autoRefreshToken: false },
  };
  const authClient = createClient(supabaseUrl, anonKey, {
    ...clientOptions,
    global: { fetch: fetcher },
  });
  const admin = createClient(
    supabaseUrl,
    serviceRoleKey,
    { ...clientOptions, global: { fetch: fetcher } },
  );
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const headers: Record<string, string> = {
      "Access-Control-Allow-Headers":
        "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Cache-Control": "no-store",
      "Vary": "Origin",
    };
    if (origin && allowedOrigins.has(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
    }
    const json = (body: unknown, status = 200) =>
      Response.json(body, { status, headers });

    try {
      if (origin && !allowedOrigins.has(origin)) {
        throw new HttpError(403, "origin_not_allowed");
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers });
      }
      const token = request.headers.get("authorization")?.match(
        /^Bearer (\S+)$/i,
      )
        ?.[1];
      if (!token) throw new HttpError(401, "unauthorized");
      // Never derive user identity from an unverified JWT or a request body.
      const { data: auth, error: authError } = await authClient.auth.getUser(
        token,
      );
      if (authError || !auth.user) throw new HttpError(401, "unauthorized");
      const userId = auth.user.id;
      const userClient = createClient(supabaseUrl, anonKey, {
        ...clientOptions,
        global: {
          fetch: fetcher,
          headers: { Authorization: `Bearer ${token}` },
        },
      });
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/(?:functions\/v1\/)?game-api/, "");

      if (request.method === "GET" && path === "/collection") {
        const rawLimit = url.searchParams.get("limit") ?? "100";
        if (!/^\d+$/.test(rawLimit)) throw new HttpError(400, "invalid_limit");
        const limit = Number(rawLimit);
        if (limit < 1 || limit > 200) throw new HttpError(400, "invalid_limit");
        const cursor = url.searchParams.get("cursor");
        if (cursor && cursor.length > 250) {
          throw new HttpError(400, "invalid_cursor");
        }
        let query = userClient.from("collection")
          .select(
            "card_key,kind,integer_value,special_id,quantity,first_collected_at",
          )
          .eq("user_id", userId).order("card_key").limit(limit + 1);
        if (cursor) query = query.gt("card_key", cursor);
        const { data, error } = await query;
        if (error) throw error;
        const page = data.slice(0, limit);
        return json({
          cards: page.map((row) => ({
            card: row.kind === "integer"
              ? { kind: "integer", value: row.integer_value }
              : { kind: "special", id: row.special_id },
            quantity: row.quantity,
            firstCollectedAt: row.first_collected_at,
          })),
          nextCursor: data.length > limit
            ? page[page.length - 1].card_key
            : null,
        });
      }

      if (
        (request.method === "GET" && path === "/me") ||
        (request.method === "POST" && path === "/packs/open")
      ) {
        const requestId = request.method === "POST"
          ? await readRequestId(request)
          : null;
        const { data: player, error: playerError } = await admin.rpc(
          "ensure_player",
          { p_user_id: userId },
        );
        if (playerError) throw playerError;
        if (!requestId) {
          return json({
            userId,
            distinctCards: player.distinct_cards,
            packsOpened: player.packs_opened,
            negativesUnlocked:
              player.distinct_cards >= GAME_RULES.negativeUnlockDistinctCards,
            nextPackAvailableAt: player.next_pack_available_at,
            serverTime: new Date().toISOString(),
          });
        }
        const { data: pack, error } = await admin.rpc("award_pack", {
          p_user_id: userId,
          p_request_id: requestId,
          p_expected_distinct: player.distinct_cards,
          p_cards: generatePack(player.distinct_cards),
        });
        if (error) throw error;
        if (pack.error === "cooldown") {
          headers["Retry-After"] = String(Math.max(
            1,
            Math.ceil(
              (Date.parse(pack.nextPackAvailableAt) - Date.now()) / 1000,
            ),
          ));
          return json(pack, 429);
        }
        if (pack.error === "progression_changed") return json(pack, 409);
        return json(pack);
      }

      if (["/me", "/collection", "/packs/open"].includes(path)) {
        throw new HttpError(405, "method_not_allowed");
      }
      throw new HttpError(404, "not_found");
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.code }, error.status);
      }
      // Avoid logging request headers, tokens, or backend error payloads.
      console.error("Game API request failed");
      return json({ error: "internal_error" }, 500);
    }
  };
}
