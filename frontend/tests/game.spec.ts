import { expect, type Page, test } from "@playwright/test";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "collector@example.com",
  aud: "authenticated",
  role: "authenticated",
};
const anonKey = "sb_publishable_local_test";
const cards = Array.from(
  { length: 10 },
  (_, i) => ({ kind: "integer", value: String(i) }),
);
const collection = cards.map((card) => ({ card, quantity: 1 }));
type TestOwned = {
  card: { kind: string; value?: string; id?: string; label?: string };
  quantity: number;
};
function albumResponse(items: TestOwned[], page = "0") {
  const integerCards = items.filter((item) => item.card.kind === "integer");
  const pages = integerCards.map((item) => {
    const value = BigInt(item.card.value!);
    return value >= 0n ? value / 100n : (value - 99n) / 100n;
  });
  return {
    page,
    minPage: String(pages.reduce((a, b) => a < b ? a : b, 0n)),
    maxPage: String(pages.reduce((a, b) => a > b ? a : b, 0n)),
    cards: integerCards.filter((_, i) => pages[i] === BigInt(page)),
    specials: items.filter((item) => item.card.kind === "special"),
  };
}
const basePlayer = {
  distinctCards: 0,
  packsOpened: 0,
  negativesUnlocked: false,
  specialsUnlocked: false,
  packAllowances: 1,
  maxPackAllowances: 6,
  nextAllowanceAt: null,
};

async function mockAuth(page: Page) {
  await page.route("http://127.0.0.1:54321/auth/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "http://localhost:5173",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        },
      });
    }
    const headers = { "Access-Control-Allow-Origin": "http://localhost:5173" };
    if (url.pathname.endsWith("/signup")) {
      return route.fulfill({ json: user, headers });
    }
    if (url.pathname.endsWith("/logout")) {
      return route.fulfill({ json: {}, headers });
    }
    const payload = btoa(
      JSON.stringify({
        sub: user.id,
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    return route.fulfill({
      headers,
      json: {
        access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.test-signature`,
        refresh_token: "test-refresh-token",
        expires_in: 3600,
        token_type: "bearer",
        user,
      },
    });
  });
}

async function connect(page: Page) {
  await page.goto("/");
  await page.getByLabel("Publishable or anon key").fill(anonKey);
  await page.getByRole("button", { name: "Connect to local game" }).click();
}

async function signIn(page: Page) {
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open a pack" })).toBeEnabled();
}

test("signup uses local email confirmation; login, opening, collection, and signout work", async ({ page }) => {
  await mockAuth(page);
  let opened = false;
  await page.route(
    "http://127.0.0.1:54321/functions/v1/game-api/**",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const headers = {
        "Access-Control-Allow-Origin": "http://localhost:5173",
        "Access-Control-Allow-Headers": "*",
      };
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers,
        });
      }
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      if (path.endsWith("/me")) {
        return route.fulfill({
          headers,
          json: {
            ...basePlayer,
            distinctCards: opened ? 10 : 0,
            packsOpened: opened ? 1 : 0,
            packAllowances: opened ? 0 : 1,
            nextAllowanceAt: opened
              ? new Date(Date.now() + 14400000).toISOString()
              : null,
            serverTime: new Date().toISOString(),
          },
        });
      }
      if (path.endsWith("/album")) {
        return route.fulfill({
          headers,
          json: albumResponse(opened ? collection : []),
        });
      }
      opened = true;
      expect(Object.keys(route.request().postDataJSON())).toEqual([
        "requestId",
      ]);
      return route.fulfill({
        headers,
        json: {
          cards,
          replayed: false,
          packAllowances: 0,
          nextAllowanceAt: new Date(Date.now() + 14400000).toISOString(),
        },
      });
    },
  );
  await connect(page);
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Check the local mail viewer",
  );
  await expect(page.getByRole("link", { name: "local mail viewer" }))
    .toHaveAttribute("href", "http://localhost:54324");
  await signIn(page);
  await page.getByRole("button", { name: "Open a pack" }).click();
  await expect(page.getByRole("heading", { name: "Your latest pack" }))
    .toBeVisible();
  await expect(page.locator(".pack-cards .number-card")).toHaveCount(10);
  await expect(page.locator(".album-slot.owned"))
    .toHaveCount(10);
  await expect(page.getByRole("button", { name: "Open a pack" }))
    .toBeDisabled();
  await expect(page.locator("#pack-time")).toContainText("Next allowance in");
  await expect(page.locator(".intro")).toHaveCount(0);
  await expect(page.locator(".album-slot.owned").first())
    .toBeInViewport();
  await expect(page.getByRole("link", { name: "Latest pack ↓" }))
    .toHaveAttribute("href", "#latest-pack");
  await page.screenshot({
    path: "test-results/collection-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator(".album-slot.owned").first())
    .toBeInViewport();
  await page.screenshot({
    path: "test-results/collection-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true }))
    .toBeVisible();
  await expect(page.getByRole("heading", { name: "Your stash" }))
    .toHaveCount(0);
});

test("an interrupted opening retains its request ID across reload and recovers the original pack", async ({ page }) => {
  await mockAuth(page);
  let requestId: string | null = null;
  let failed = false;
  await page.route(
    "http://127.0.0.1:54321/functions/v1/game-api/**",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const headers = {
        "Access-Control-Allow-Origin": "http://localhost:5173",
        "Access-Control-Allow-Headers": "*",
      };
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers,
        });
      }
      if (path.endsWith("/me")) {
        return route.fulfill({
          headers,
          json: {
            ...basePlayer,
            packAllowances: failed ? 0 : 1,
            nextAllowanceAt: failed
              ? new Date(Date.now() + 14400000).toISOString()
              : null,
            serverTime: new Date().toISOString(),
          },
        });
      }
      if (path.endsWith("/album")) {
        return route.fulfill({
          headers,
          json: albumResponse([]),
        });
      }
      const nextId = route.request().postDataJSON().requestId;
      if (!failed) {
        requestId = nextId;
        failed = true;
        return route.abort("failed");
      }
      expect(nextId).toBe(requestId);
      return route.fulfill({
        headers,
        json: {
          cards,
          replayed: true,
          packAllowances: 0,
          nextAllowanceAt: new Date(Date.now() + 14400000).toISOString(),
        },
      });
    },
  );
  await connect(page);
  await signIn(page);
  await page.getByRole("button", { name: "Open a pack" }).click();
  await expect(page.getByRole("button", { name: "Retry pack opening" }))
    .toBeEnabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry pack opening" }))
    .toBeEnabled();
  await page.getByRole("button", { name: "Retry pack opening" }).click();
  await expect(page.getByRole("heading", { name: "Your recovered pack" }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Open a pack" }))
    .toBeDisabled();
});

test("connection rejects server keys and remote instances", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Publishable or anon key").fill("sb_secret_test");
  await page.getByRole("button", { name: "Connect to local game" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Use a publishable or anon key.",
  );
  await page.getByLabel("Supabase URL").fill("https://example.supabase.co");
  await page.getByLabel("Publishable or anon key").fill(anonKey);
  await page.getByRole("button", { name: "Connect to local game" }).click();
  await expect(page.getByRole("alert")).toContainText("local Supabase");
});

for (const initial of [3, 6]) {
  test(`${initial} saved allowances can be spent without waiting for a refill`, async ({ page }) => {
    await mockAuth(page);
    let available = initial;
    let next = initial === 6
      ? null
      : new Date(Date.now() + 3 * 3600000).toISOString();
    const requests = new Set<string>();
    await page.route(
      "http://127.0.0.1:54321/functions/v1/game-api/**",
      async (route) => {
        const headers = {
          "Access-Control-Allow-Origin": "http://localhost:5173",
          "Access-Control-Allow-Headers": "*",
        };
        if (route.request().method() === "OPTIONS") {
          return route.fulfill({ status: 204, headers });
        }
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/me")) {
          return route.fulfill({
            headers,
            json: {
              ...basePlayer,
              packAllowances: available,
              nextAllowanceAt: next,
              serverTime: new Date().toISOString(),
            },
          });
        }
        if (path.endsWith("/album")) {
          return route.fulfill({
            headers,
            json: albumResponse([]),
          });
        }
        const id = route.request().postDataJSON().requestId;
        expect(requests.has(id)).toBe(false);
        requests.add(id);
        available--;
        next ??= new Date(Date.now() + 4 * 3600000).toISOString();
        return route.fulfill({
          headers,
          json: {
            cards,
            replayed: false,
            packAllowances: available,
            nextAllowanceAt: next,
          },
        });
      },
    );
    await connect(page);
    await signIn(page);
    await expect(page.locator("#pack-balance")).toHaveText(
      `${initial} of 6 packs available`,
    );
    if (initial === 6) {
      await expect(page.locator("#pack-time")).toContainText("balance is full");
    }
    for (let count = initial; count > 0; count--) {
      await page.getByRole("button", { name: "Open a pack" }).click();
      await expect(page.locator("#pack-balance")).toHaveText(
        `${count - 1} of 6 packs available`,
      );
      if (count > 1) {
        await expect(page.getByRole("button", { name: "Open a pack" }))
          .toBeEnabled();
      }
    }
    await expect(page.getByRole("button", { name: "Open a pack" }))
      .toBeDisabled();
    await expect(page.locator("#pack-time")).toContainText("Next allowance in");
    expect(requests.size).toBe(initial);
  });
}

test("reaching 100 unlocks specials and pi renders in packs and the stash", async ({ page }) => {
  await mockAuth(page);
  let opened = 0;
  const pi = { kind: "special", id: "pi" };
  await page.route(
    "http://127.0.0.1:54321/functions/v1/game-api/**",
    async (route) => {
      const headers = {
        "Access-Control-Allow-Origin": "http://localhost:5173",
        "Access-Control-Allow-Headers": "*",
      };
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers,
        });
      }
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/me")) {
        return route.fulfill({
          headers,
          json: {
            ...basePlayer,
            distinctCards: 99 + opened,
            negativesUnlocked: true,
            specialsUnlocked: opened > 0,
            packAllowances: 3 - opened,
            nextAllowanceAt: new Date(Date.now() + 14400000).toISOString(),
            serverTime: new Date().toISOString(),
          },
        });
      }
      if (path.endsWith("/album")) {
        return route.fulfill({
          headers,
          json: albumResponse(opened > 1 ? [{ card: pi, quantity: 2 }] : []),
        });
      }
      opened++;
      return route.fulfill({
        headers,
        json: {
          cards: opened === 1 ? cards : [pi, pi, ...cards.slice(0, 8)],
          replayed: false,
          packAllowances: 3 - opened,
          nextAllowanceAt: new Date(Date.now() + 14400000).toISOString(),
        },
      });
    },
  );
  await connect(page);
  await signIn(page);
  const milestone = page.locator(".stats div").filter({
    hasText: "Special numbers",
  });
  await expect(milestone).toContainText("Locked");
  await expect(milestone).toContainText("unlock at 100");
  await page.getByRole("button", { name: "Open a pack" }).click();
  await expect(milestone).toContainText("Unlocked");
  await expect(page.locator(".pack-cards .number").filter({ hasText: "π" }))
    .toHaveCount(0);
  await page.getByRole("button", { name: "Open a pack" }).click();
  await expect(page.locator(".pack-cards .number").filter({ hasText: "π" }))
    .toHaveCount(2);
  const owned = page.locator(".cards:not(.pack-cards) .number-card");
  await expect(owned).toContainText("π");
  await expect(owned).toContainText("SPECIAL");
  await expect(owned).toContainText("× 2 stashed");
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  ).toBe(true);
});

test("all special symbols render from API labels in packs and the stash", async ({ page }) => {
  await mockAuth(page);
  let opened = false;
  const specials = [
    { kind: "special", id: "pi", label: "π" },
    { kind: "special", id: "e", label: "e" },
    { kind: "special", id: "phi", label: "φ" },
    { kind: "special", id: "i", label: "i" },
    { kind: "special", id: "sqrt2", label: "√2" },
  ];
  await page.route(
    "http://127.0.0.1:54321/functions/v1/game-api/**",
    async (route) => {
      const headers = {
        "Access-Control-Allow-Origin": "http://localhost:5173",
        "Access-Control-Allow-Headers": "*",
      };
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers,
        });
      }
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/me")) {
        return route.fulfill({
          headers,
          json: {
            ...basePlayer,
            distinctCards: 100,
            specialsUnlocked: true,
            negativesUnlocked: true,
            packAllowances: opened ? 0 : 1,
            nextAllowanceAt: new Date(Date.now() + 14400000).toISOString(),
            serverTime: new Date().toISOString(),
          },
        });
      }
      if (path.endsWith("/album")) {
        return route.fulfill({
          headers,
          json: albumResponse(
            opened ? specials.map((card) => ({ card, quantity: 2 })) : [],
          ),
        });
      }
      opened = true;
      return route.fulfill({
        headers,
        json: {
          cards: [...specials, ...specials],
          replayed: false,
          packAllowances: 0,
          nextAllowanceAt: new Date(Date.now() + 14400000).toISOString(),
        },
      });
    },
  );
  await connect(page);
  await signIn(page);
  await page.getByRole("button", { name: "Open a pack" }).click();
  for (const special of specials) {
    await expect(
      page.locator(".pack-cards").getByText(special.label, { exact: true }),
    ).toHaveCount(2);
    await expect(
      page.locator(".cards:not(.pack-cards)").getByText(special.label, {
        exact: true,
      }),
    ).toHaveCount(1);
  }
});

test("integer album has 100 slots, exact negative pages, bounded jumps, and separate specials", async ({ page }) => {
  await mockAuth(page);
  const huge = String(10n ** 80n + 123n);
  const items: TestOwned[] = [
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
    .map((value) => ({ card: { kind: "integer", value }, quantity: 3 }));
  items.push({ card: { kind: "special", id: "phi", label: "φ" }, quantity: 4 });
  await page.route(
    "http://127.0.0.1:54321/functions/v1/game-api/**",
    async (route) => {
      const headers = {
        "Access-Control-Allow-Origin": "http://localhost:5173",
        "Access-Control-Allow-Headers": "*",
      };
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers,
        });
      }
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/me")) {
        return route.fulfill({
          headers,
          json: {
            ...basePlayer,
            distinctCards: items.length,
            nextAllowanceAt: new Date(Date.now() + 14400000).toISOString(),
            serverTime: new Date().toISOString(),
          },
        });
      }
      expect(url.pathname.endsWith("/album")).toBe(true);
      return route.fulfill({
        headers,
        json: albumResponse(items, url.searchParams.get("page") ?? "0"),
      });
    },
  );
  await connect(page);
  await signIn(page);
  await expect(page.locator(".album-slot")).toHaveCount(100);
  await expect(page.locator(".album-slot.missing")).toHaveCount(98);
  await expect(page.locator(".album-slot").nth(0)).toHaveAttribute(
    "aria-label",
    "0: 3 stashed",
  );
  await expect(page.locator(".album-slot").nth(1)).toHaveText("");
  await expect(page.locator(".album-slot").nth(99)).toHaveAttribute(
    "aria-label",
    "99: 3 stashed",
  );
  await expect(page.locator(".special-cards")).toContainText("φ");
  await expect(page.locator(".special-cards")).toContainText("× 4 stashed");
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(page.locator("#page-range")).toHaveText("-100 to -1");
  await expect(page.locator(".album-slot").nth(0)).toHaveAttribute(
    "aria-label",
    "-100: 3 stashed",
  );
  await expect(page.locator(".album-slot").nth(99)).toHaveAttribute(
    "aria-label",
    "-1: 3 stashed",
  );
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(page.locator("#page-range")).toHaveText("-200 to -101");
  await expect(page.getByRole("button", { name: "Previous page" }))
    .toBeDisabled();
  await expect(page.locator(".album-slot.owned")).toHaveCount(1);
  await page.getByLabel("Jump to number").fill("-12");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.locator("#page-range")).toHaveText("-100 to -1");
  await page.getByLabel("Jump to number").fill("150");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.locator("#page-range")).toHaveText("100 to 199");
  await expect(page.locator(".album-slot").nth(0)).toHaveAttribute(
    "aria-label",
    "100: 3 stashed",
  );
  await expect(page.locator(".album-slot").nth(99)).toHaveAttribute(
    "aria-label",
    "199: 3 stashed",
  );
  await page.getByLabel("Jump to number").fill(huge);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  const start = BigInt(huge) / 100n * 100n;
  await expect(page.locator("#page-range")).toHaveText(
    `${start} to ${start + 99n}`,
  );
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  await expect(page.locator(".album-slot.owned")).toHaveAttribute(
    "aria-label",
    `${huge}: 3 stashed`,
  );
  await page.getByLabel("Jump to number").fill("1" + huge);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Choose a number between",
  );
  await page.getByLabel("Jump to number").fill("1.5");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Enter a whole number");
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.locator(".album-grid").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length
    ),
  ).toBe(10);
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  ).toBe(true);
});
