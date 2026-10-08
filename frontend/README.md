# Frontend

Small TypeScript/Vite web app for the local and hosted Supabase backend. It
provides:

- A local connection screen accepting only public keys and loopback HTTP URLs.
- Email/password signup, confirmation through the local mail viewer, and login.
- A pack-opening button, balance of up to six packs, and refill countdown using
  the backend's server time. The displayed balance updates as allowances refill.
- Pack recovery with the same request ID after a lost response or page reload.
- An integer album with 10×10 pages, empty slots for missing numbers, duplicate
  quantities, Previous/Next navigation, and jumping directly to a number.
- Album bounds cover the full integer collection, including negative numbers and
  values beyond JavaScript's safe integer range. Page 0 (0–99) always exists.
- Special numbers appear in their own section, independent of the integer page.
- The entire collection is fetched once and held in memory. Page navigation
  makes no network requests. Opening a pack, Refresh, or a page reload fetches a
  fresh snapshot; signing out clears it.
- Negative and special unlock milestones; π, e, φ, i, and √2 use catalog labels
  in packs and the stash. Specials unlock at 100 distinct cards with a 0.5%
  chance per draw.
- Session persistence and signout through Supabase Auth.

After sign-in, the stash is the main view. Desktop pack controls and progress
sit in a sidebar; mobile uses a compact pack bar above the collection. Latest
pack results appear below the stash, with a shortcut beside Refresh.

Follow the [root setup guide](../README.md) to start Supabase and the app. Use
`http://localhost:5173` rather than a different port or host, matching the
backend's default CORS origin and Auth redirect URL. No environment file is
needed: enter the local Publishable or anon key into the connection screen. The
server secret key is never used by this app.

All app assets and fonts are bundled; no font CDN is used. During local
development, the local connection is stored in browser local storage, along with
the session managed by the Supabase SDK. A pending pack ID is scoped to the
signed-in user.

From the repository root:

```sh
pnpm dev
pnpm build
pnpm preview
pnpm --dir frontend exec playwright install chromium
pnpm test:web
```

## Production

Live frontend: **https://number-club.pages.dev** (Cloudflare Pages project
`number-club`). Use `pnpm deploy:web` from the repository root to publish
updates.

`pnpm build` produces `frontend/dist/`, connected automatically to
`https://csmhjxjmxhdsrcqbgrxp.supabase.co`. Public configuration lives in
`src/production-config.ts`; the publishable key is intended to be included in
the browser bundle. No server secret key is included. Production ignores saved
local connections and shows ordinary inbox confirmation instructions. `pnpm dev`
continues to use the local connection screen and mail viewer.

Use `pnpm preview` to inspect the production build at `http://localhost:5174`.
That preview uses the hosted project, so signup or login uses production
accounts. Browser tests cover both development and production with simulated
APIs and do not create real accounts or call the hosted project.

### Cloudflare Pages

From the repository root, sign in and create the Pages project once:

```sh
pnpm exec wrangler login
pnpm exec wrangler pages project create number-club --production-branch main
```

Build and deploy:

```sh
pnpm deploy:web
```

Wrangler reports the deployed URL. If you prefer a different project name,
change `--project-name` in the root `deploy:web` script and use that name when
creating it. This uses Pages Direct Upload, which can also be deployed by CI.
Cloudflare's built-in Git integration requires creating a project in that mode
instead; use `pnpm build` from the repository root and `frontend/dist` as its
output directory.

The production domain is `https://mynumberstash.com`. In Cloudflare Pages,
associate it with the `number-club` project under Custom domains and confirm the
proposed DNS record. Wait for the domain to show Active before using it.

Supabase Auth uses that domain as its Site URL. Redirect URLs and the backend's
`ALLOWED_ORIGINS` allow both it and `https://number-club.pages.dev`. Signup
confirmation links return to the origin where signup started. Custom SMTP is
configured through the dashboard; see
[email setup](../backend/README.md#signup-email-delivery).
