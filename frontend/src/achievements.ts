export type AchievementCounts = {
  squares: number;
  cubes: number;
  primes: number;
  fibonacci: number;
  triangular: number;
  palindromes: number;
  opposites: number;
  uncheckedPrimes: number;
};

// Integer Newton iteration: work depends on digit length, not the number's value.
function root(n: bigint, degree: 2 | 3): bigint {
  if (n < 2n) return n;
  const d = BigInt(degree);
  let current = 1n << BigInt(Math.ceil(n.toString(2).length / degree));
  while (true) {
    const next = ((d - 1n) * current + n / current ** (d - 1n)) / d;
    if (next >= current) return current;
    current = next;
  }
}

function square(n: bigint): boolean {
  if (n < 0n) return false;
  const r = root(n, 2);
  return r * r === n;
}

function powerMod(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  while (exponent > 0n) {
    if (exponent % 2n) result = result * base % modulus;
    base = base * base % modulus;
    exponent /= 2n;
  }
  return result;
}

function prime(n: bigint): boolean | null {
  if (n < 2n) return false;
  // Deterministic Miller–Rabin with Jim Sinclair's seven bases for n < 2^64.
  // https://miller-rabin.appspot.com/
  if (n >= 2n ** 64n) return null;
  for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  let odd = n - 1n;
  let twos = 0;
  while (odd % 2n === 0n) {
    odd /= 2n;
    twos++;
  }
  for (const witness of [2n, 325n, 9375n, 28178n, 450775n, 9780504n, 1795265022n]) {
    const base = witness % n;
    if (base === 0n) continue;
    let x = powerMod(base, odd, n);
    if (x === 1n || x === n - 1n) continue;
    let passed = false;
    for (let i = 1; i < twos; i++) {
      x = x * x % n;
      if (x === n - 1n) {
        passed = true;
        break;
      }
    }
    if (!passed) return false;
  }
  return true;
}

export function countAchievements(values: string[]): AchievementCounts {
  const numbers = new Set(values.map(value => BigInt(value)));
  let maximum = 0n;
  for (const n of numbers) if (n > maximum) maximum = n;
  // The sequence grows exponentially; even 200-digit values need under 1,000 terms.
  const fibonacci = new Set<bigint>();
  let a = 0n;
  let b = 1n;
  while (a <= maximum) {
    fibonacci.add(a);
    [a, b] = [b, a + b];
  }
  const counts: AchievementCounts = {
    squares: 0, cubes: 0, primes: 0, fibonacci: 0, triangular: 0,
    palindromes: 0, opposites: 0, uncheckedPrimes: 0,
  };
  for (const n of numbers) {
    if (square(n)) counts.squares++;
    const absolute = n < 0n ? -n : n;
    const cubeRoot = root(absolute, 3);
    if (cubeRoot ** 3n === absolute) counts.cubes++;
    const primality = prime(n);
    if (primality === null) counts.uncheckedPrimes++;
    else if (primality) counts.primes++;
    if (fibonacci.has(n)) counts.fibonacci++;
    if (n >= 0n) {
      if (square(8n * n + 1n)) counts.triangular++;
      const text = n.toString();
      if (text === [...text].reverse().join("")) counts.palindromes++;
    }
    if (n > 0n && numbers.has(-n)) counts.opposites++;
  }
  return counts;
}
