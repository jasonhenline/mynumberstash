import { assertEquals, assertThrows } from "@std/assert";
import {
  GAME_RULES,
  generatePack,
  geometricInteger,
} from "../supabase/functions/_shared/cards.ts";

Deno.test("geometric integer counts successes before the first failure", () => {
  const draws = [0.1, 0.89, 0.9];
  assertEquals(geometricInteger(0.9, () => draws.shift()!), 2n);
  assertEquals(geometricInteger(0.9, () => 0.99), 0n);
  assertThrows(() => geometricInteger(1), RangeError);
});

Deno.test("negatives are unavailable before the unlock threshold", () => {
  const pack = generatePack(
    GAME_RULES.negativeUnlockDistinctCards - 1,
    () => 0.99,
  );
  assertEquals(pack.length, 10);
  assertEquals(pack, Array(10).fill({ kind: "integer", value: "0" }));
});

Deno.test("negative draws start at minus one and never produce negative zero", () => {
  let draw = 0;
  const pack = generatePack(50, () => draw++ % 2 === 0 ? 0.1 : 0.99);
  assertEquals(pack, Array(10).fill({ kind: "integer", value: "-1" }));
});

Deno.test("geometric distribution has the expected mean and zero frequency", () => {
  let seed = 42;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  let sum = 0;
  let zeros = 0;
  for (let i = 0; i < 20000; i++) {
    const n = Number(geometricInteger(0.9, random));
    sum += n;
    if (n === 0) zeros++;
  }
  if (Math.abs(sum / 20000 - 9) > 0.3 || Math.abs(zeros / 20000 - 0.1) > 0.01) {
    throw new Error(
      "Distribution differs from expected geometric probabilities",
    );
  }
});
