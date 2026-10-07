import { assertEquals, assertRejects } from "@std/assert";
import {
  HttpError,
  readRequestId,
} from "../supabase/functions/_shared/http.ts";

const requestId = "10000000-0000-4000-8000-000000000001";
const request = (body: string) =>
  new Request("http://localhost", { method: "POST", body });

Deno.test("pack requests accept only a request ID, never client-selected cards", async () => {
  assertEquals(
    await readRequestId(request(JSON.stringify({ requestId }))),
    requestId,
  );
  await assertRejects(
    () => readRequestId(request(JSON.stringify({ requestId, cards: [] }))),
    HttpError,
  );
  await assertRejects(() => readRequestId(request("null")), HttpError);
  await assertRejects(() => readRequestId(request("{}")), HttpError);
  await assertRejects(() => readRequestId(request("broken JSON")), HttpError);
  await assertRejects(
    () => readRequestId(request("x".repeat(1025))),
    HttpError,
  );
});
