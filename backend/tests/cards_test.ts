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
  const count = 20000;
  const ratio = GAME_RULES.geometricRatio;
  const expectedMean = ratio / (1 - ratio);
  const expectedZero = 1 - ratio;
  const meanTolerance = 5 * Math.sqrt(ratio) / (1 - ratio) / Math.sqrt(count);
  const zeroTolerance = 5 * Math.sqrt(expectedZero * ratio / count);
  for (let i = 0; i < count; i++) {
    const n = Number(geometricInteger(ratio, random));
    sum += n;
    if (n === 0) zeros++;
  }
  if (
    Math.abs(sum / count - expectedMean) > meanTolerance ||
    Math.abs(zeros / count - expectedZero) > zeroTolerance
  ) {
    throw new Error(
      "Distribution differs from expected geometric probabilities",
    );
  }
});
