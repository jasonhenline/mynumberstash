import { expect, test } from "@playwright/test";
import { productionConnection } from "../src/production-config";

test("production automatically uses hosted Supabase and provides normal email confirmation", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "number-club.connection",
      JSON.stringify({
        url: "http://127.0.0.1:54321",
        key: "sb_publishable_stale_local",
      }),
    );
  });
  // These browser tests never call the real project or create real accounts.
  await page.route("https://**/*", (route) => route.abort());
  let signupCalled = false;
  await page.route(
    `${productionConnection.url}/auth/v1/signup*`,
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "http://localhost:5174",
            "Access-Control-Allow-Headers": "*",
          },
        });
      }
      signupCalled = true;
      expect(route.request().headers().apikey).toBe(productionConnection.key);
      expect(route.request().url()).toContain(
        "redirect_to=http%3A%2F%2Flocalhost%3A5174",
      );
      return route.fulfill({
        headers: { "Access-Control-Allow-Origin": "http://localhost:5174" },
        json: {
          id: "00000000-0000-4000-8000-000000000001",
          email: "collector@example.com",
        },
      });
    },
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to the club." }))
    .toBeVisible();
  await expect(page.getByLabel("Publishable or anon key")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change connection" }))
    .toHaveCount(0);
  await expect(page.getByRole("link", { name: "local mail viewer" }))
    .toHaveCount(0);
  await expect(page.locator(".environment")).not.toContainText("LOCAL");
  await page.getByLabel("Email", { exact: true }).fill("collector@example.com");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("Check your inbox");
  expect(signupCalled).toBe(true);
});

test("hosted backend failures show a useful message without local setup instructions", async ({ page }) => {
  await page.route("https://**/*", (route) => route.abort());
  const user = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "collector@example.com",
    role: "authenticated",
    aud: "authenticated",
  };
  await page.route(
    `${productionConnection.url}/auth/v1/token*`,
    (route) =>
      route.fulfill({
        headers: { "Access-Control-Allow-Origin": "http://localhost:5174" },
        json: {
          user,
          access_token: `eyJhbGciOiJIUzI1NiJ9.${
            btoa(
              JSON.stringify({
                sub: user.id,
                role: "authenticated",
                exp: Math.floor(Date.now() / 1000) + 3600,
              }),
            )
          }.test`,
          refresh_token: "test-refresh",
          expires_in: 3600,
          token_type: "bearer",
        },
      }),
  );
  await page.route(
    `${productionConnection.url}/functions/v1/game-api/**`,
    (route) =>
      route.fulfill({
        status: 503,
        headers: { "Access-Control-Allow-Origin": "http://localhost:5174" },
        json: { error: "unavailable" },
      }),
  );
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).not.toContainText("local backend");
  await expect(page.getByRole("button", { name: "Open a pack" }))
    .toBeDisabled();
});
