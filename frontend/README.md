# Frontend

Small TypeScript/Vite web app for the local Supabase backend. It provides:

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

All app assets and fonts are local; no font CDN or hosted Supabase service is
used. The local connection is stored in browser local storage, along with the
session managed by the Supabase SDK. A pending pack ID is scoped to the
signed-in user.

From the repository root:

```sh
pnpm dev
pnpm build
pnpm --dir frontend exec playwright install chromium
pnpm test:web
```

The production build is written to `frontend/dist/`. This app currently accepts
local backend connections only. Browser tests use a simulated backend,
preserving real Supabase SDK session handling; use the local Docker stack to
verify the full backend and email confirmation flow.
