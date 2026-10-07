export type Card =
  | { kind: "integer"; value: string }
  | { kind: "special"; id: string; label: string };

export type SpecialCardDefinition = { id: string; label: string };

export const GAME_RULES = {
  packSize: 10,
  // Matches flooring an exponential random variable with scale 50.
  geometricRatio: Math.exp(-1 / 50),
  negativeUnlockDistinctCards: 50,
  negativeProbability: 0.10,
  specialUnlockDistinctCards: 100,
  specialProbability: 0.005,
} as const;

/** Uniform [0, 1), supplied by the server rather than the caller. */
export function secureRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

/** P(N=n)=(1-r)r^n. Repeated trials avoid an inverse-CDF magnitude cutoff. */
export function geometricInteger(
  ratio: number,
  random: () => number = secureRandom,
): bigint {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw new RangeError("Ratio must be between zero and one");
  }
  let value = 0n;
  while (random() < ratio) value++;
  return value;
}

export function generatePack(
  distinctCards: number,
  random: () => number = secureRandom,
  specials: readonly SpecialCardDefinition[] = [],
): Card[] {
  const negativesUnlocked =
    distinctCards >= GAME_RULES.negativeUnlockDistinctCards;
  const specialsUnlocked =
    distinctCards >= GAME_RULES.specialUnlockDistinctCards;
  if (specialsUnlocked && specials.length === 0) {
    throw new Error("No special cards configured");
  }
  return Array.from({ length: GAME_RULES.packSize }, () => {
    if (specialsUnlocked && random() < GAME_RULES.specialProbability) {
      const special = specials[Math.floor(random() * specials.length)];
      return { kind: "special" as const, id: special.id, label: special.label };
    }
    const negative = negativesUnlocked &&
      random() < GAME_RULES.negativeProbability;
    const magnitude = geometricInteger(GAME_RULES.geometricRatio, random);
    return {
      kind: "integer" as const,
      value: (negative ? -(magnitude + 1n) : magnitude).toString(),
    };
  });
}
