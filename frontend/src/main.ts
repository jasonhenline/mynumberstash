import {
  createClient,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import "./style.css";
import { productionConnection } from "./production-config";

const localDevelopment = import.meta.env.DEV;

type Card = { kind: "integer"; value: string } | {
  kind: "special";
  id: string;
};
type OwnedCard = { card: Card; quantity: number };
type Player = {
  distinctCards: number;
  packsOpened: number;
  negativesUnlocked: boolean;
  nextPackAvailableAt: string | null;
  serverTime: string;
};
type Pack = { cards: Card[]; replayed: boolean; nextPackAvailableAt: string };
type Connection = { url: string; key: string };

const app = document.querySelector<HTMLDivElement>("#app")!;
let client: SupabaseClient | null = null;
let connection: Connection | null = null;
let session: Session | null = null;
let player: Player | null = null;
let collection: OwnedCard[] = [];
let cursor: string | null = null;
let pack: Pack | null = null;
let pendingId: string | null = null;
let busy = false;
let message = "";
let messageKind: "success" | "error" = "success";
let clockOffset = 0;
let unsubscribe: (() => void) | null = null;

const escape = (value: unknown): string =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const label = (card: Card): string =>
  card.kind === "integer" ? card.value : card.id;
const pendingKey = (userId: string): string =>
  `number-club.pending.${connection!.url}.${userId}`;

function notify(text: string, kind: "success" | "error" = "success") {
  message = text;
  messageKind = kind;
  render();
}

function cardMarkup(card: Card, quantity?: number): string {
  return `<div class="number-card"><span class="card-kind">${
    card.kind === "integer" ? "INTEGER" : "SPECIAL"
  }</span>
    <span class="number">${escape(label(card))}</span>
    <span class="card-footer">${
    quantity === undefined ? "NUMBER CLUB" : `× ${escape(quantity)} collected`
  }</span></div>`;
}

function render() {
  app.innerHTML = `
    <header><a class="brand" href="/">N<span>°</span> <span class="brand-name">NUMBER CLUB</span></a><span class="environment"><i></i> ${
    localDevelopment ? "LOCAL PLAYGROUND" : "COLLECT SOMETHING INFINITE"
  }</span></header>
    <main>
      <div class="intro"><span class="eyebrow">A LITTLE COLLECTION OF INFINITY</span><h1>Every number<br>has a place.</h1><p>Ten cards. Four hours. A collection that keeps growing.</p></div>
      ${
    message
      ? `<div class="notice ${messageKind}" role="${
        messageKind === "error" ? "alert" : "status"
      }">${escape(message)}</div>`
      : ""
  }
      ${
    !connection ? connectionMarkup() : !session ? authMarkup() : gameMarkup()
  }
    </main>
    <footer><span>Small numbers. Endless possibilities.</span><span>NUMBER CLUB · 001</span></footer>`;
  bind();
  updateCountdown();
}

function connectionMarkup(): string {
  return `<section class="panel setup"><span class="eyebrow">CONNECT YOUR LOCAL GAME</span><h2>Let's get started.</h2>
    <p>Start the local backend, then paste its public key here.</p>
    <form id="connect-form">
      <label for="url">Supabase URL</label><input id="url" name="url" type="url" value="http://127.0.0.1:54321" required>
      <label for="key">Publishable or anon key</label><input id="key" name="key" autocomplete="off" required placeholder="Your local public key">
      <button type="submit">Connect to local game <span>↗</span></button>
    </form><p class="fine-print">Use the Publishable or anon key from the Supabase CLI. The server secret key belongs only in the backend.</p></section>`;
}

function authMarkup(): string {
  return `<section class="panel setup"><span class="eyebrow">YOUR COLLECTION STARTS HERE</span><h2>Welcome to the club.</h2>
    <form id="auth-form">
      <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required placeholder="collector@example.com">
      <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" minlength="6" required placeholder="At least 6 characters">
      <div class="actions"><button type="submit" ${busy ? "disabled" : ""}>${
    busy ? "Please wait…" : "Sign in"
  }</button>
        <button class="secondary" type="submit" name="signup" ${
    busy ? "disabled" : ""
  }>Create account</button></div>
    </form><p class="fine-print">${
    localDevelopment
      ? 'After signing up, confirm your email in the <a href="http://localhost:54324" target="_blank" rel="noopener noreferrer">local mail viewer ↗</a>, then sign in here.'
      : "After signing up, check your inbox to confirm your email, then sign in."
  }</p>
    ${
    localDevelopment
      ? '<button class="text-button" id="disconnect">Change connection</button>'
      : ""
  }</section>`;
}

function gameMarkup(): string {
  const sorted = [...collection].sort((a, b) => {
    if (a.card.kind === "integer" && b.card.kind === "integer") {
      const left = BigInt(a.card.value), right = BigInt(b.card.value);
      return left < right ? -1 : left > right ? 1 : 0;
    }
    return label(a.card).localeCompare(label(b.card));
  });
  return `<div class="account"><span>${
    escape(session!.user.email ?? "Collector")
  }</span><button class="text-button" id="signout" ${
    busy ? "disabled" : ""
  }>Sign out</button></div>
    <section class="pack-panel"><div><span class="eyebrow">YOUR NEXT DISCOVERY</span><h2>Room for ten more.</h2><p id="pack-time" aria-live="off">Checking your next pack…</p>
      <button id="open-pack" ${busy || !player ? "disabled" : ""}>${
    busy ? "Working…" : pendingId ? "Retry pack opening" : "Open a pack"
  } <span>＋</span></button></div>
      <div class="pack-art" aria-hidden="true"><div class="art-card back">7</div><div class="art-card front">0<span>THE POSSIBILITIES BEGIN HERE</span></div></div></section>
    <section class="stats" aria-label="Collection statistics"><div><strong>${
    player?.distinctCards ?? "—"
  }</strong><span>Distinct numbers</span></div><div><strong>${
    player?.packsOpened ?? "—"
  }</strong><span>Packs opened</span></div><div><strong>${
    player ? player.negativesUnlocked ? "Unlocked" : "Locked" : "—"
  }</strong><span>Negative numbers · unlock at 50</span></div></section>
    ${
    pack
      ? `<section><div class="section-heading"><h2>${
        pack.replayed ? "Your recovered pack" : "Your latest pack"
      }</h2><span>10 new cards</span></div><div class="cards pack-cards">${
        pack.cards.map((card) => cardMarkup(card)).join("")
      }</div></section>`
      : ""
  }
    <section><div class="section-heading"><h2>Your collection</h2><button id="refresh" class="text-button" ${
    busy ? "disabled" : ""
  }>Refresh ↻</button></div>
      ${
    collection.length
      ? `<div class="cards">${
        sorted.map((item) => cardMarkup(item.card, item.quantity)).join("")
      }</div>`
      : `<div class="empty"><span>∅</span><h3>A blank page, for now.</h3><p>Open your first pack to start collecting.</p></div>`
  }
      ${
    cursor
      ? `<button id="load-more" class="secondary" ${
        busy ? "disabled" : ""
      }>Load more numbers</button>`
      : ""
  }</section>`;
}

function updateCountdown() {
  const text = document.querySelector("#pack-time");
  const button = document.querySelector<HTMLButtonElement>("#open-pack");
  if (!text || !button) return;
  const remaining = player?.nextPackAvailableAt
    ? Math.max(
      0,
      Math.ceil(
        (Date.parse(player.nextPackAvailableAt) - Date.now() - clockOffset) /
          1000,
      ),
    )
    : 0;
  text.textContent = pendingId
    ? "An opening needs confirmation. Retry to recover the same pack."
    : !player
    ? "Loading your game…"
    : remaining === 0
    ? "Your next pack is ready."
    : `Next pack in ${Math.floor(remaining / 3600)}h ${
      Math.floor(remaining % 3600 / 60)
    }m ${remaining % 60}s`;
  button.disabled = busy || !player || (remaining > 0 && !pendingId);
}

class ApiError extends Error {
  constructor(
    public status: number,
    public payload: { error?: string; nextPackAvailableAt?: string },
  ) {
    super(
      payload.error === "cooldown"
        ? "Your next pack isn't ready yet."
        : payload.error === "unauthorized"
        ? "Your session has expired. Please sign in again."
        : payload.error === "progression_changed"
        ? "Your collection changed. Please retry this opening."
        : "The game request failed. Please try again.",
    );
  }
}

async function api<T>(path: string, body?: object): Promise<T> {
  const { data, error } = await client!.auth.getSession();
  if (error || !data.session) throw new Error("Please sign in to continue.");
  const response = await fetch(
    `${connection!.url}/functions/v1/game-api${path}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        apikey: connection!.key,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    },
  );
  const payload = await response.json();
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload as T;
}

async function loadGame() {
  const userId = session?.user.id;
  if (!userId) return;
  const [status, page] = await Promise.all([
    api<Player>("/me"),
    api<{ cards: OwnedCard[]; nextCursor: string | null }>(
      "/collection?limit=100",
    ),
  ]);
  if (session?.user.id !== userId) return;
  player = status;
  clockOffset = Date.parse(status.serverTime) - Date.now();
  collection = page.cards;
  cursor = page.nextCursor;
  render();
}

async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  message = "";
  render();
  try {
    await action();
  } catch (error) {
    message = error instanceof Error ? error.message : "Something went wrong.";
    messageKind = "error";
  } finally {
    busy = false;
    render();
  }
}

function bind() {
  document.querySelector<HTMLFormElement>("#connect-form")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget as HTMLFormElement);
      try {
        const url = new URL(String(form.get("url")));
        if (
          !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
          url.protocol !== "http:" || url.username || url.password
        ) {
          throw new Error("Use the HTTP URL of your local Supabase instance.");
        }
        const key = String(form.get("key")).trim();
        if (key.startsWith("sb_secret_")) {
          throw new Error(
            "Use a publishable or anon key.",
          );
        }
        if (!key.startsWith("sb_publishable_")) {
          let role: unknown;
          try {
            role = JSON.parse(
              atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
            ).role;
          } catch {
            throw new Error("Enter a valid publishable or anon key.");
          }
          if (role !== "anon") {
            throw new Error("Use a publishable or anon key.");
          }
        }
        connect({ url: url.origin, key });
      } catch (error) {
        notify((error as Error).message, "error");
      }
    },
  );
  document.querySelector<HTMLFormElement>("#auth-form")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget as HTMLFormElement);
      const signup = (event.submitter as HTMLButtonElement)?.name === "signup";
      void run(async () => {
        const credentials = {
          email: String(form.get("email")),
          password: String(form.get("password")),
        };
        const { data, error } = signup
          ? await client!.auth.signUp({
            ...credentials,
            options: { emailRedirectTo: location.origin },
          })
          : await client!.auth.signInWithPassword(credentials);
        if (error) throw error;
        if (data.session) {
          session = data.session;
          pendingId = localStorage.getItem(pendingKey(session.user.id));
          await loadGame();
        } else {
          notify(
            localDevelopment
              ? "Check the local mail viewer to confirm your email, then sign in."
              : "Check your inbox to confirm your email, then sign in.",
          );
        }
      });
    },
  );
  document.querySelector("#disconnect")?.addEventListener("click", () => {
    unsubscribe?.();
    client?.auth.stopAutoRefresh();
    client = null;
    connection = null;
    localStorage.removeItem("number-club.connection");
    message = "";
    render();
  });
  document.querySelector("#signout")?.addEventListener(
    "click",
    () =>
      void run(async () => {
        const { error } = await client!.auth.signOut({ scope: "local" });
        if (error) throw error;
        session = null;
        player = null;
        collection = [];
        pack = null;
        cursor = null;
        pendingId = null;
      }),
  );
  document.querySelector("#refresh")?.addEventListener(
    "click",
    () => void run(loadGame),
  );
  document.querySelector("#load-more")?.addEventListener(
    "click",
    () =>
      void run(async () => {
        const page = await api<
          { cards: OwnedCard[]; nextCursor: string | null }
        >(`/collection?limit=100&cursor=${encodeURIComponent(cursor!)}`);
        const merged = new Map(
          collection.map((
            item,
          ) => [`${item.card.kind}:${label(item.card)}`, item]),
        );
        for (const item of page.cards) {
          merged.set(`${item.card.kind}:${label(item.card)}`, item);
        }
        collection = [...merged.values()];
        cursor = page.nextCursor;
      }),
  );
  document.querySelector("#open-pack")?.addEventListener(
    "click",
    () =>
      void run(async () => {
        const storageKey = pendingKey(session!.user.id);
        pendingId ??= crypto.randomUUID();
        localStorage.setItem(storageKey, pendingId);
        try {
          pack = await api<Pack>("/packs/open", { requestId: pendingId });
          localStorage.removeItem(storageKey);
          pendingId = null;
          if (player) player.nextPackAvailableAt = pack.nextPackAvailableAt;
          notify(
            pack.replayed
              ? "Recovered your original pack."
              : "Ten new numbers to make your own.",
          );
          await loadGame();
        } catch (error) {
          if (
            error instanceof ApiError && [400, 413, 429].includes(error.status)
          ) {
            localStorage.removeItem(storageKey);
            pendingId = null;
            if (player && error.payload.nextPackAvailableAt) {
              player.nextPackAvailableAt = error.payload.nextPackAvailableAt;
            }
          }
          throw error;
        }
      }),
  );
}

function connect(config: Connection) {
  unsubscribe?.();
  client?.auth.stopAutoRefresh();
  connection = config;
  session = null;
  player = null;
  collection = [];
  pack = null;
  pendingId = null;
  cursor = null;
  if (localDevelopment) {
    localStorage.setItem("number-club.connection", JSON.stringify(config));
  }
  client = createClient(config.url, config.key);
  const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
    // Defer API calls until the Auth callback releases its internal lock.
    setTimeout(() => {
      if (connection !== config) return;
      const changedUser = session?.user.id !== nextSession?.user.id;
      // INITIAL_SESSION with no saved login should not replace an active form.
      if (!changedUser && !nextSession) return;
      session = nextSession;
      if (changedUser) {
        player = null;
        collection = [];
        pack = null;
        cursor = null;
      }
      pendingId = session
        ? localStorage.getItem(pendingKey(session.user.id))
        : null;
      render();
      if (session && !busy) {
        void loadGame().catch(() =>
          notify(
            localDevelopment
              ? "Could not load the game. Check that the local backend and Edge Function are running, then refresh."
              : "Could not load your collection. Please try refreshing in a moment.",
            "error",
          )
        );
      }
    }, 0);
  });
  unsubscribe = () => data.subscription.unsubscribe();
  message = "";
  render();
}

try {
  if (!localDevelopment) {
    connect(productionConnection);
  } else {
    const saved = localStorage.getItem("number-club.connection");
    if (saved) connect(JSON.parse(saved) as Connection);
    else render();
  }
} catch {
  localStorage.removeItem("number-club.connection");
  render();
}
setInterval(updateCountdown, 1000);
