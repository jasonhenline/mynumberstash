import { expect, test } from "@playwright/test";
import { countAchievements } from "../src/achievements";

test("category counts are exact, distinct, and use the documented zero and sign conventions", () => {
  expect(countAchievements([])).toEqual({
    squares: 0, cubes: 0, primes: 0, fibonacci: 0, triangular: 0,
    palindromes: 0, opposites: 0, uncheckedPrimes: 0,
  });
  const values = Array.from({ length: 2001 }, (_, i) => String(i - 1000));
  expect(countAchievements([...values, ...values])).toEqual({
    squares: 32, cubes: 21, primes: 168, fibonacci: 16, triangular: 45,
    palindromes: 109, opposites: 1000, uncheckedPrimes: 0,
  });
  expect(countAchievements(["0", "0"])).toEqual({
    squares: 1, cubes: 1, primes: 0, fibonacci: 1, triangular: 1,
    palindromes: 1, opposites: 0, uncheckedPrimes: 0,
  });
});

test("large integer checks stay exact and primality work has a fixed bound", () => {
  const square = 10n ** 198n;
  expect(countAchievements([String(square)]).squares).toBe(1);
  expect(countAchievements([String(square - 1n), String(square + 1n)]).squares).toBe(0);
  const cube = (10n ** 60n + 1n) ** 3n;
  expect(countAchievements([String(-cube)]).cubes).toBe(1);
  expect(countAchievements([String(cube - 1n), String(cube + 1n)]).cubes).toBe(0);
  const k = 10n ** 80n;
  expect(countAchievements([String(k * (k + 1n) / 2n)]).triangular).toBe(1);
  let a = 0n;
  let b = 1n;
  for (let i = 0; i < 900; i++) [a, b] = [b, a + b];
  expect(countAchievements([String(a)]).fibonacci).toBe(1);
  expect(countAchievements([String(a + 1n)]).fibonacci).toBe(0);
  expect(countAchievements([String(2n ** 61n - 1n)]).primes).toBe(1);
  expect(countAchievements([String(10670053n * 32010157n)]).primes).toBe(0);
  expect(countAchievements([String(2n ** 64n - 1n)]).uncheckedPrimes).toBe(0);
  expect(countAchievements([String(2n ** 64n), "9".repeat(200)]).uncheckedPrimes).toBe(2);
});

test("achievements use the in-memory collection, cache calculations, and refresh after changes", async ({ page }) => {
  const user = { id: "00000000-0000-4000-8000-000000000001", email: "collector@example.com", role: "authenticated", aud: "authenticated" };
  await page.route("https://**/*", route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem("number-club.connection", JSON.stringify({ url: "http://127.0.0.1:54321", key: "sb_publishable_local_test" }));
    const RealWorker = window.Worker;
    const state = window as unknown as { achievementWorkers: number };
    state.achievementWorkers = 0;
    window.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        state.achievementWorkers++;
      }
    };
  });
  await page.route("http://127.0.0.1:54321/auth/v1/**", route => {
    const headers = { "Access-Control-Allow-Origin": "http://localhost:5173", "Access-Control-Allow-Headers": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const token = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub: user.id, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }))}.test`;
    return route.fulfill({ headers, json: { access_token: token, refresh_token: "test-refresh", expires_in: 3600, token_type: "bearer", user } });
  });
  let opened = false;
  const values = ["0", "1", "2", "3", "4", "8", "9", "10", "11", "-1", "-8"];
  let reads = 0;
  await page.route("http://127.0.0.1:54321/functions/v1/game-api/**", route => {
    const headers = { "Access-Control-Allow-Origin": "http://localhost:5173", "Access-Control-Allow-Headers": "*" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/packs/open")) {
      opened = true;
      return route.fulfill({ headers, json: { cards: Array(10).fill({ kind: "integer", value: "16" }), newCardKeys: ["integer:16"], replayed: false, packAllowances: 0, nextAllowanceAt: new Date(Date.now() + 14400000).toISOString() } });
    }
    reads++;
    return route.fulfill({ headers, json: path.endsWith("/stash") ? {
      cards: [
        ...[...values, ...(opened ? ["16"] : [])].map(value => ({ card: { kind: "integer", value }, quantity: 99 })),
        { card: { kind: "special", id: "pi", label: "π" }, quantity: 99 },
      ],
    } : { distinctCards: values.length, packsOpened: 0, packAllowances: opened ? 0 : 1, maxPackAllowances: 6, nextAllowanceAt: null, serverTime: new Date().toISOString() } });
  });
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open a pack" })).toBeEnabled();
  const initialReads = reads;
  await page.getByRole("link", { name: "Achievements", exact: true }).click();
  for (const [key, expected] of Object.entries({ squares: 4, cubes: 5, primes: 3, fibonacci: 5, triangular: 4, palindromes: 8, opposites: 2 })) {
    await expect(page.locator(`[data-achievement="${key}"] dd`)).toHaveText(String(expected));
  }
  expect(reads).toBe(initialReads);
  expect(await page.evaluate(() => (window as unknown as { achievementWorkers: number }).achievementWorkers)).toBe(1);
  await page.getByRole("link", { name: "Stash", exact: true }).click();
  await page.getByRole("link", { name: "Achievements", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { achievementWorkers: number }).achievementWorkers)).toBe(1);
  // Change the refreshed collection so the old rendered count cannot satisfy
  // the assertion while the network request is still in flight.
  values.push("25");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.locator('[data-achievement="squares"] dd')).toHaveText("5");
  expect(await page.evaluate(() => (window as unknown as { achievementWorkers: number }).achievementWorkers)).toBe(2);
  expect(reads).toBe(initialReads + 2);
  await page.getByRole("link", { name: "Stash", exact: true }).click();
  await page.getByRole("button", { name: "Open a pack" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reveal all", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your latest pack" })).toBeVisible();
  await page.getByRole("link", { name: "Achievements", exact: true }).click();
  await expect(page.locator('[data-achievement="squares"] dd')).toHaveText("6");
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/achievements-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Achievements", exact: true })).toHaveCount(0);
});
