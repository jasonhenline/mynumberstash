# Number collecting game

This repository holds both parts of the game:

- `backend/`: Supabase authentication, Postgres migrations, and TypeScript Edge
  Functions.
- `frontend/`: a small web app for playing against local Supabase, including
  signup and login.

## Run locally

You do not need a hosted Supabase account. Local Supabase includes Postgres,
Auth, Edge Functions, and a mail viewer for confirmation emails.

Requirements: Node 22+, pnpm 10, and a running Docker-compatible container
runtime. Deno 2 is needed only for the backend checks.

From this directory:

```sh
pnpm install
pnpm backend:start
```

The first start downloads the Supabase containers and applies the database
migrations. Keep the **Publishable** key (or legacy **anon** key) shown by the
CLI for the app's connection screen.

In a second terminal, serve the backend functions:

```sh
pnpm backend:serve
```

In a third terminal, start the web app:

```sh
pnpm dev
```

Open **http://localhost:5173**. Connect using `http://127.0.0.1:54321` and the
local public key, create an account, and confirm its email in
**http://localhost:54324**. Then sign in, open your first pack, and view your
collection. Email stays in the local mail viewer; no email provider is required.
Supabase Studio is available at **http://localhost:54323**.

The normal four-hour cooldown applies locally. Connection details and the login
session persist in your browser. Retry an interrupted pack opening with the
app's retry button to recover the original pack without being charged another
opening.

Stop the web/function processes with Ctrl+C, then use `pnpm backend:stop` to
stop the containers while retaining local data. These commands do not deploy
anything.

## Checks

```sh
pnpm build
pnpm --dir frontend exec playwright install chromium
pnpm test:web
```

Browser tests simulate the local API and verify signup, login, collecting cards,
cooldowns, signout, and recovery after a lost response. They do not require
Docker. See [the backend guide](backend/README.md) for database tests, game
rules, and deployment details, and [the frontend guide](frontend/README.md) for
app details.

## Production frontend

Production domain: **https://mynumberstash.com**; the existing
**https://number-club.pages.dev** address also works. Publish updates with
`pnpm deploy:web` after signing in to Cloudflare with Wrangler.

`pnpm build` creates the production frontend in `frontend/dist/`, automatically
connected to the hosted Supabase project. The URL and publishable key are public
configuration in `frontend/src/production-config.ts`. Local development with
`pnpm dev` keeps the local setup described above.

`pnpm preview` serves the production build at `http://localhost:5174`. It uses
the hosted project, so production account operations are real. Deployment and
hosted Auth configuration are described in
[the frontend guide](frontend/README.md#production).
