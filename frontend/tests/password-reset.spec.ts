import { expect, type Page, test } from "@playwright/test";
import { productionConnection } from "../src/production-config";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "collector@example.com",
  aud: "authenticated",
  role: "authenticated",
};
const localConnection = {
  url: "http://127.0.0.1:54321",
  key: "sb_publishable_local_test",
};

async function setup(page: Page, production: boolean) {
  const config = production ? productionConnection : localConnection;
  const origin = production ? "http://localhost:5174" : "http://localhost:5173";
  await page.addInitScript(config => {
    localStorage.setItem("number-club.connection", JSON.stringify(config));
  }, config);
  // Never send these tests to the real hosted project or email provider.
  await page.route("https://**/*", route => route.abort());
  const state = { requests: 0, updates: 0, failRequest: false, updateStatus: 200 };
  await page.route(`${config.url}/auth/v1/**`, async route => {
    const headers = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    };
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers });
    }
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/recover")) {
      state.requests++;
      expect(route.request().postDataJSON().email).toBe(user.email);
      expect(url.searchParams.get("redirect_to")).toBe(`${origin}/reset-password`);
      return route.fulfill({
        headers,
        status: state.failRequest ? 429 : 200,
        json: state.failRequest ? { msg: "Please wait before requesting another email." } : {},
      });
    }
    if (route.request().method() === "PUT") {
      expect(url.pathname.endsWith("/user")).toBe(true);
      expect(route.request().postDataJSON().password).toBe("new-test-password");
      expect(route.request().headers().authorization).toMatch(/^Bearer /);
      state.updates++;
      return route.fulfill({
        headers, status: state.updateStatus,
        json: state.updateStatus === 200 ? user : { msg: "Password update rejected." },
      });
    }
    expect(url.pathname.endsWith("/user")).toBe(true);
    return route.fulfill({ headers, json: user });
  });
  let gameReads = 0;
  await page.route(`${config.url}/functions/v1/game-api/**`, route => {
    gameReads++;
    return route.fulfill({
      headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "*" },
      json: route.request().url().endsWith("/stash") ? { cards: [] } : {
        distinctCards: 0, packsOpened: 0, packAllowances: 1, maxPackAllowances: 6,
        nextAllowanceAt: null, serverTime: new Date().toISOString(),
      },
    });
  });
  const token = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({
    sub: user.id, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600,
  }))}.test-signature`;
  const recoveryUrl = `/reset-password#access_token=${token}&refresh_token=test-refresh-token&expires_in=3600&token_type=bearer&type=recovery`;
  return { state, recoveryUrl, gameReads: () => gameReads };
}

test("requesting a reset gives a neutral confirmation, handles errors, and returns to sign in", async ({ page }, info) => {
  const { state } = await setup(page, info.project.name === "production");
  await page.goto("/");
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  state.failRequest = true;
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("alert")).toContainText("Please wait");
  state.failRequest = false;
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText("If an account exists");
  await expect(page.getByRole("status")).toContainText(
    info.project.name === "production" ? "inbox" : "local mail viewer",
  );
  expect(state.requests).toBe(2);
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

test("a verified recovery link survives reload, validates confirmation, and updates the password", async ({ page }, info) => {
  const { state, recoveryUrl, gameReads } = await setup(page, info.project.name === "production");
  await page.goto(recoveryUrl);
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
  expect(gameReads()).toBe(0);
  expect(new URL(page.url()).hash).toBe("");
  await page.reload();
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill("new-test-password");
  await page.getByLabel("Confirm new password").fill("different-password");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByRole("alert")).toContainText("don’t match");
  expect(state.updates).toBe(0);
  state.updateStatus = 422;
  await page.getByLabel("New password", { exact: true }).fill("new-test-password");
  await page.getByLabel("Confirm new password").fill("new-test-password");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByRole("alert")).toContainText("Password update rejected");
  state.updateStatus = 200;
  await page.getByLabel("New password", { exact: true }).fill("new-test-password");
  await page.getByLabel("Confirm new password").fill("new-test-password");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByRole("status")).toContainText("password has been updated");
  await expect(page.getByRole("heading", { name: "Your stash" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(state.updates).toBe(2);
  await page.goto("/reset-password");
  await expect(page.getByText("This reset link has expired or is invalid.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveCount(0);
});

test("expired and missing recovery links offer a fresh reset instead of a password form", async ({ page }, info) => {
  const { state } = await setup(page, info.project.name === "production");
  await page.goto("/reset-password#error=access_denied&error_code=otp_expired&error_description=expired");
  await expect(page.getByText("This reset link has expired or is invalid.", { exact: false })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.getByRole("button", { name: "Save new password" })).toHaveCount(0);
  await page.getByRole("button", { name: "Request a new reset link" }).click();
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeVisible();
  await page.goto("/reset-password");
  await expect(page.getByText("This reset link has expired or is invalid.", { exact: false })).toBeVisible();
  expect(state.updates).toBe(0);
});

test("an expired recovery session cannot update a password", async ({ page }, info) => {
  const { state, recoveryUrl } = await setup(page, info.project.name === "production");
  await page.goto(recoveryUrl);
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
  state.updateStatus = 401;
  await page.getByLabel("New password", { exact: true }).fill("new-test-password");
  await page.getByLabel("Confirm new password").fill("new-test-password");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByRole("alert")).toContainText("reset session has expired");
  await expect(page.getByRole("button", { name: "Request a new reset link" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save new password" })).toHaveCount(0);
});
