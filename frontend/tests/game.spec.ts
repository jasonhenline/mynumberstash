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
const basePlayer = {
  distinctCards: 0,
  packsOpened: 0,
  negativesUnlocked: false,
  nextPackAvailableAt: null,
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
            nextPackAvailableAt: opened
              ? new Date(Date.now() + 14400000).toISOString()
              : null,
            serverTime: new Date().toISOString(),
          },
        });
      }
      if (path.endsWith("/collection")) {
        return route.fulfill({
          headers,
          json: { cards: opened ? collection : [], nextCursor: null },
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
          nextPackAvailableAt: new Date(Date.now() + 14400000).toISOString(),
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
  await expect(page.locator(".cards:not(.pack-cards) .number-card"))
    .toHaveCount(10);
  await expect(page.getByRole("button", { name: "Open a pack" }))
    .toBeDisabled();
  await expect(page.locator("#pack-time")).toContainText("Next pack in");
  await page.screenshot({
    path: "test-results/collection-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
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
            nextPackAvailableAt: failed
              ? new Date(Date.now() + 14400000).toISOString()
              : null,
            serverTime: new Date().toISOString(),
          },
        });
      }
      if (path.endsWith("/collection")) {
        return route.fulfill({
          headers,
          json: { cards: [], nextCursor: null },
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
          nextPackAvailableAt: new Date(Date.now() + 14400000).toISOString(),
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
