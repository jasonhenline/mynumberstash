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
  label?: string;
};
type OwnedCard = { card: Card; quantity: number };
type Album = {
  page: string;
  minPage: string;
  maxPage: string;
  cards: OwnedCard[];
  specials: OwnedCard[];
};
type Player = {
  distinctCards: number;
  packsOpened: number;
  negativesUnlocked: boolean;
  specialsUnlocked: boolean;
  packAllowances: number;
  maxPackAllowances: number;
  nextAllowanceAt: string | null;
  serverTime: string;
};
type Pack = {
  cards: Card[];
  replayed: boolean;
  packAllowances: number;
  nextAllowanceAt: string;
};
type Connection = { url: string; key: string };

const app = document.querySelector<HTMLDivElement>("#app")!;
let client: SupabaseClient | null = null;
let connection: Connection | null = null;
let session: Session | null = null;
let player: Player | null = null;
let album: Album | null = null;
let albumPage = "0";
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
  card.kind === "integer"
    ? card.value
    : card.label ?? (card.id === "pi" ? "π" : card.id);
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
    quantity === undefined ? "MY NUMBER STASH" : `× ${escape(quantity)} stashed`
  }</span></div>`;
}

function render() {
  app.innerHTML = `
    <header><a class="brand" href="/">N<span>°</span> <span class="brand-name">MY NUMBER STASH</span></a>${
    session
      ? `<div class="account"><span>${
        escape(session.user.email ?? "Collector")
      }</span><button class="text-button" id="signout" ${
        busy ? "disabled" : ""
      }>Sign out</button></div>`
      : `<span class="environment"><i></i> ${
        localDevelopment ? "LOCAL PLAYGROUND" : "ENDLESS FINDS"
      }</span>`
  }</header>
    <main class="${session ? "game" : "welcome"}">
      ${
    !session
      ? '<div class="intro"><span class="eyebrow">A LITTLE STASH OF INFINITY</span><h1>Every number<br>has a place.</h1><p>Ten cards per pack. Save up to six packs, with one refilling every four hours.</p></div>'
      : ""
  }
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
    <footer><span>Small numbers. Endless possibilities.</span><span>MY NUMBER STASH · 001</span></footer>`;
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
  return `<section class="panel setup"><span class="eyebrow">YOUR STASH STARTS HERE</span><h2>Start your number stash.</h2>
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
  return `<div class="stash-layout">
    <section class="stash-section" aria-labelledby="stash-title">
      <div class="section-heading stash-heading"><div><span class="eyebrow">A LITTLE STASH OF INFINITY</span><h1 id="stash-title">Your stash</h1></div><div class="stash-actions">${
    pack ? '<a class="text-button" href="#latest-pack">Latest pack ↓</a>' : ""
  }<button id="refresh" class="text-button" ${
    busy ? "disabled" : ""
  }>Refresh ↻</button></div></div>
      ${album ? albumMarkup() : '<p class="fine-print">Loading your stash…</p>'}
    </section>
    <aside class="game-sidebar" aria-label="Packs and progress">
      <section class="pack-panel"><div class="pack-info"><span class="eyebrow">ADD TO YOUR STASH</span><p id="pack-balance">Checking your packs…</p><p id="pack-time" aria-live="off">Checking your next refill…</p></div>
        <button id="open-pack" ${busy || !player ? "disabled" : ""}>${
    busy ? "Working…" : pendingId ? "Retry pack opening" : "Open a pack"
  } <span>＋</span></button>
      </section>
      <section class="stats" aria-label="Stash statistics"><div><strong>${
    player?.distinctCards ?? "—"
  }</strong><span>Distinct numbers</span></div><div><strong>${
    player?.packsOpened ?? "—"
  }</strong><span>Packs opened</span></div><div><strong>${
    player ? player.negativesUnlocked ? "Unlocked" : "Locked" : "—"
  }</strong><span>Negative numbers · unlock at 50</span></div><div><strong>${
    player ? player.specialsUnlocked ? "Unlocked" : "Locked" : "—"
  }</strong><span>Special numbers · unlock at 100</span></div></section>
    </aside>
  </div>
  ${
    pack
      ? `<section class="latest-pack" id="latest-pack"><div class="section-heading"><h2>${
        pack.replayed ? "Your recovered pack" : "Your latest pack"
      }</h2><span>10 new cards</span></div><div class="cards pack-cards">${
        pack.cards.map((card) => cardMarkup(card)).join("")
      }</div></section>`
      : ""
  }`;
}

function pageForNumber(value: bigint): bigint {
  return value >= 0n ? value / 100n : (value - 99n) / 100n;
}

function albumMarkup(): string {
  const page = BigInt(album!.page);
  const start = page * 100n;
  const end = start + 99n;
  const owned = new Map(
    album!.cards.flatMap((item) =>
      item.card.kind === "integer"
        ? [[item.card.value, item.quantity] as const]
        : []
    ),
  );
  const slots = Array.from({ length: 100 }, (_, i) => {
    const value = String(start + BigInt(i));
    const quantity = owned.get(value);
    const description = quantity === undefined
      ? `${value}: not collected`
      : `${value}: ${quantity} stashed`;
    return `<div class="album-slot ${
      quantity === undefined ? "missing" : "owned"
    }" role="listitem" aria-label="${escape(description)}" title="${
      escape(description)
    }">${
      quantity === undefined
        ? ""
        : `<span class="slot-number">${
          escape(value)
        }</span><span class="slot-quantity">×${escape(quantity)}</span>`
    }</div>`;
  });
  return `<div class="album-controls"><div class="page-navigation"><button id="previous-page" class="secondary" ${
    busy || page === BigInt(album!.minPage) ? "disabled" : ""
  } aria-label="Previous page">←</button><span id="page-range">${
    escape(start)
  } to ${escape(end)}</span><button id="next-page" class="secondary" ${
    busy || page === BigInt(album!.maxPage) ? "disabled" : ""
  } aria-label="Next page">→</button></div>
    <form id="jump-form"><label for="jump-number">Jump to number</label><input id="jump-number" name="number" type="text" maxlength="200" required placeholder="e.g. 150 or -12"><button class="secondary" ${
    busy ? "disabled" : ""
  }>Go</button></form></div>
    <div class="album-grid" role="list" aria-label="Numbers ${
    escape(start)
  } to ${escape(end)}">${slots.join("")}</div>
    <p class="album-caption">${owned.size} of 100 numbers found on this page. Empty spaces are waiting to be filled.</p>
    <section class="special-section" aria-labelledby="special-title"><div class="section-heading"><h2 id="special-title">Special numbers</h2><span>${
    album!.specials.length
  } found</span></div>${
    album!.specials.length
      ? `<div class="cards special-cards">${
        [...album!.specials].sort((a, b) =>
          label(a.card).localeCompare(label(b.card))
        ).map((item) => cardMarkup(item.card, item.quantity)).join("")
      }</div>`
      : `<p class="fine-print">${
        player?.specialsUnlocked
          ? "Special numbers you discover will appear here."
          : "Special numbers unlock at 100 distinct cards."
      }</p>`
  }</section>`;
}

function updateCountdown() {
  const text = document.querySelector("#pack-time");
  const balance = document.querySelector("#pack-balance");
  const button = document.querySelector<HTMLButtonElement>("#open-pack");
  if (!text || !button) return;
  const now = Date.now() + clockOffset;
  const interval = 4 * 60 * 60 * 1000;
  const next = player?.nextAllowanceAt
    ? Date.parse(player.nextAllowanceAt)
    : null;
  const refills = next !== null && next <= now
    ? 1 + Math.floor((now - next) / interval)
    : 0;
  const available = player
    ? Math.min(player.maxPackAllowances, player.packAllowances + refills)
    : 0;
  const full = player && available === player.maxPackAllowances;
  const remaining = next !== null
    ? Math.max(0, Math.ceil((next + refills * interval - now) / 1000))
    : 0;
  if (balance && player) {
    balance.textContent =
      `${available} of ${player.maxPackAllowances} packs available`;
  }
  text.textContent = pendingId
    ? "An opening needs confirmation. Retry to recover the same pack."
    : !player
    ? "Loading your game…"
    : full
    ? "Your pack balance is full. Open a pack to start refilling."
    : `Next allowance in ${
      remaining >= 60
        ? `${Math.floor(remaining / 3600)}h ${
          Math.floor(remaining % 3600 / 60)
        }m`
        : `${remaining}s`
    }`;
  button.disabled = busy || !player || (available === 0 && !pendingId);
}

class ApiError extends Error {
  constructor(
    public status: number,
    public payload: { error?: string; nextAllowanceAt?: string },
  ) {
    super(
      payload.error === "cooldown"
        ? "Your next pack isn't ready yet."
        : payload.error === "unauthorized"
        ? "Your session has expired. Please sign in again."
        : payload.error === "progression_changed"
        ? "Your stash changed. Please retry this opening."
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
  const [status, nextAlbum] = await Promise.all([
    api<Player>("/me"),
    api<Album>(`/album?page=${encodeURIComponent(albumPage)}`),
  ]);
  if (session?.user.id !== userId) return;
  player = status;
  clockOffset = Date.parse(status.serverTime) - Date.now();
  album = nextAlbum;
  albumPage = nextAlbum.page;
  render();
}

async function loadAlbum(page: string) {
  const userId = session?.user.id;
  const result = await api<Album>(`/album?page=${encodeURIComponent(page)}`);
  if (!userId || session?.user.id !== userId) return;
  album = result;
  albumPage = result.page;
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
        album = null;
        albumPage = "0";
        pack = null;
        pendingId = null;
      }),
  );
  document.querySelector("#refresh")?.addEventListener(
    "click",
    () => void run(loadGame),
  );
  for (
    const [id, delta] of [["previous-page", -1n], ["next-page", 1n]] as const
  ) {
    document.querySelector(`#${id}`)?.addEventListener(
      "click",
      () => void run(() => loadAlbum(String(BigInt(albumPage) + delta))),
    );
  }
  document.querySelector<HTMLFormElement>("#jump-form")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      if (!album) return;
      const form = new FormData(event.currentTarget as HTMLFormElement);
      const value = String(form.get("number")).trim();
      if (!/^(0|-?[1-9][0-9]*)$/.test(value) || value.length > 200) {
        notify("Enter a whole number, such as 150 or -12.", "error");
        return;
      }
      const page = pageForNumber(BigInt(value));
      if (
        page < BigInt(album.minPage) || page > BigInt(album.maxPage)
      ) {
        notify(
          `Choose a number between ${BigInt(album.minPage) * 100n} and ${
            BigInt(album.maxPage) * 100n + 99n
          }.`,
          "error",
        );
        return;
      }
      void run(() => loadAlbum(String(page)));
    },
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
          if (player) {
            player.nextAllowanceAt = pack.nextAllowanceAt;
            player.packAllowances = pack.packAllowances;
          }
          notify(
            pack.replayed
              ? "Recovered your original pack."
              : "Ten more cards added to your stash.",
          );
          await loadGame();
        } catch (error) {
          if (
            error instanceof ApiError && [400, 413, 429].includes(error.status)
          ) {
            localStorage.removeItem(storageKey);
            pendingId = null;
            if (player && error.payload.nextAllowanceAt) {
              player.nextAllowanceAt = error.payload.nextAllowanceAt;
              if (error.status === 429) player.packAllowances = 0;
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
  album = null;
  albumPage = "0";
  pack = null;
  pendingId = null;
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
        album = null;
        albumPage = "0";
        pack = null;
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
              : "Could not load your stash. Please try refreshing in a moment.",
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
