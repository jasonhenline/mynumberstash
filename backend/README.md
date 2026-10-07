# Backend

Supabase supplies authentication and Postgres. The `game-api` Edge Function
verifies each caller using Supabase Auth and runs the game rules in TypeScript.
A restricted Postgres function locks the player's record, enforces the cooldown,
and saves the entire award in one transaction. Browser clients cannot call the
award function or write their own collection.

## Current game rules

- A new player can open a pack immediately.
- Every pack contains ten cards; duplicates increase quantities.
- The next pack is available four hours after the successful opening. Packs do
  not accumulate while the player is away.
- Nonnegative integers follow `P(N=n) = (1-r)r^n`, with `r=0.9` (mean 9).
- After collecting 50 distinct cards, each draw has a 25% chance of being
  negative. Negative magnitude is `N+1`, so there is no negative zero. Newly
  unlocked cards become available starting with the next pack.
- Integers are generated on the server using cryptographic randomness and
  BigInt. Their decimal strings are stored directly; there is no integer
  catalog. Storage accepts up to 200 characters per integer, a practical limit
  far beyond typical draws from this distribution.
- A special-card catalog and collection representation are included, but special
  cards are not seeded or awarded yet.

Edit `supabase/functions/_shared/cards.ts` to adjust probabilities and
progression. Pack size and cooldown are also enforced in SQL: changing those
requires a migration.

## Development

For an interactive local web app with signup and login, follow the
[root setup guide](../README.md). The frontend uses the same authenticated API
and enforces the normal cooldown; no authentication bypass is required.

Requirements: Deno 2, Node/npm (for the CLI), and Docker for the local Supabase
stack. The SQL migrations are the schema's source of truth, including
permissions and database functions. Add new migrations instead of editing
migrations already applied to a hosted database. No Terraform provisioning is
included in this first version.

From `backend/`:

```sh
deno task check
deno task test
deno task lint
deno task fmt:check

npx supabase@2.120.0 start
npx supabase@2.120.0 functions serve game-api
```

The CLI starts the local database, applies migrations, and supplies the
function's Supabase environment variables. `config.toml` configures local
development; hosted Auth URL/provider settings must be configured separately.

Local Auth emails are delivered to the local mail viewer shown by the CLI.
Create a user and sign in through Supabase Auth using the public key shown by
the CLI. Include the resulting user's access token in the API's
`Authorization: Bearer ...` header. You can use `@supabase/supabase-js` to call
`auth.signUp()` and `auth.signInWithPassword()` without a frontend.

Tests include a real Postgres engine running in memory (PGlite), with a minimal
stub of Supabase's auth schema and roles. They cover rollback, cooldowns, retry
recovery, permissions, distribution, and HTTP authentication. They do not
exercise the hosted gateway or simultaneous connections; a full Supabase
environment is needed for those.

## API

Base URL: `http://127.0.0.1:54321/functions/v1/game-api` locally, or
`https://<project-ref>.supabase.co/functions/v1/game-api` when deployed. All
routes require a Supabase user bearer token.

| Method | Path                               | Behavior                                             |
| ------ | ---------------------------------- | ---------------------------------------------------- |
| GET    | `/me`                              | Player progression, next pack time, and server time  |
| GET    | `/collection?limit=100&cursor=...` | Owned cards, quantities, and an optional next cursor |
| POST   | `/packs/open`                      | Open or recover a pack                               |

POST body:

```json
{ "requestId": "10000000-0000-4000-8000-000000000001" }
```

Generate a new UUID for each intended opening. Keep it when retrying a failed
request; an opening with the same ID returns its original cards, even during the
cooldown. No client-selected cards or user IDs are accepted.

Successful pack response:

```json
{
  "requestId": "10000000-0000-4000-8000-000000000001",
  "cards": [{ "kind": "integer", "value": "0" }],
  "openedAt": "2026-10-06T18:00:00Z",
  "nextPackAvailableAt": "2026-10-06T22:00:00Z",
  "replayed": false
}
```

The example abbreviates the cards array; actual responses contain ten cards.
Cooldown responses use HTTP 429 with `error: "cooldown"`, `nextPackAvailableAt`,
and a `Retry-After` header. A progression conflict returns HTTP 409; retry with
the same request ID. Invalid input returns 400, oversized bodies 413, invalid
sessions 401. Collection pagination is by stable card key, not numerical order;
pass `nextCursor` back as the URL-encoded `cursor` parameter until it is null.

## Deployment

Create one Supabase project, then run from `backend/`:

```sh
npx supabase@2.120.0 login
npx supabase@2.120.0 link --project-ref YOUR_PROJECT_REF
npx supabase@2.120.0 db push
npx supabase@2.120.0 secrets set ALLOWED_ORIGINS=https://YOUR_FRONTEND_HOST
npx supabase@2.120.0 functions deploy game-api
```

The platform provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY`. The service-role key stays exclusively in the
function environment. Do not put it in a frontend or commit it to Git. CORS
accepts the comma-separated `ALLOWED_ORIGINS` list; non-browser requests still
require login. Gateway JWT verification is disabled deliberately because the
handler verifies every session with `auth.getUser()` itself, including projects
with asymmetric signing keys. OPTIONS requests do not require a session.

The included GitHub Actions workflow runs checks on pull requests and pushes.
Deployment is an explicit manual workflow action using a `production`
environment. Configure these GitHub environment secrets:
`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, and `SUPABASE_PROJECT_REF`.
Supply credentials through the secret store; never commit them. Configure hosted
Auth redirect URLs and an email provider or social login before public launch.
