# Frontend

Small TypeScript/Vite web app for the local and hosted Supabase backend. It
provides:

- A local connection screen accepting only public keys and loopback HTTP URLs.
- Email/password signup, confirmation through the local mail viewer, and login.
- A pack-opening button and a countdown using the backend's server time.
- Pack recovery with the same request ID after a lost response or page reload.
- Collection quantities, numeric sorting, and pagination.
- Session persistence and signout through Supabase Auth.

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

After the hosting URL is known, set that exact origin as the Supabase Auth Site
URL and add it to the allowed redirect URLs. Configure SMTP for signup email
delivery. Set the backend's `ALLOWED_ORIGINS` to the same origin. The site can
be hosted first; collections and pack opening will work after the backend
migrations and `game-api` function are deployed. See
[backend deployment](../backend/README.md#deployment).
