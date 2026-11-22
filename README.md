# money-tracker-api

Backend of the personal money tracker (Node.js + Fastify 5 + PostgreSQL).
It runs on the Raspberry Pi **prazo-pi** on the home network and also serves the
built frontend, so the whole app is one service at **http://prazo-pi.local:3010**.

- **No login, LAN only, on purpose.** Anyone on the home Wi-Fi can use it; nothing
  is port-forwarded or tunnelled. Every request acts as the single row in `users`.
- **Safety guard:** the API refuses to start unless `DATABASE_URL` points at
  localhost (override: `ALLOW_REMOTE_DATABASE=1`). An unauthenticated build must
  never be deployed against a remote database by accident.
- Server timezone is UTC (`TZ=UTC` in the systemd unit): `DATE` columns become JS
  Dates at local midnight, so another zone would shift dates by a day.

## Setup, deploy, backups, restore

See [deploy/README.md](deploy/README.md).

## Local development

```bash
cp .env.example .env          # DATABASE_URL to a local Postgres
psql "$DATABASE_URL" -f schema.sql
npm ci
node --env-file=.env --watch src/index.js     # http://localhost:3000
```

Run the frontend with `npm run dev` in `money-tracker-frontend`: Vite proxies
`/api` to port 3000. Or build it and set `STATIC_DIR=../money-tracker-frontend/dist`.

| Variable | Meaning |
|----------|---------|
| `DATABASE_URL` | Local Postgres connection string (required) |
| `PORT` | Listen port (default 3000; 3010 on prazo-pi) |
| `STATIC_DIR` | Frontend `dist/` to serve, with SPA fallback (optional) |
| `LOG_LEVEL` | Fastify log level (default `info`) |

## API Reference

`GET /health` → `{ ok: true, ts }`. No endpoint needs a token.

### Accounts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounts` | List all accounts |
| POST | `/api/accounts` | Create account `{ name, type }`; type: debit, credit, debt, investment, cash, restricted |
| PATCH | `/api/accounts/:id` | Update name / archive |

### Snapshots (weekly balance updates)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/snapshots/latest` | Latest balance per account |
| POST | `/api/snapshots` | Save weekly update `{ recorded_at, entries[] }` |
| GET | `/api/snapshots/history?from=&to=` | History for charts |

### Incomes
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/incomes` | List incomes (optional `?from=&to=`) |
| POST | `/api/incomes` | Log income `{ amount, source, received_at, note? }` |
| DELETE | `/api/incomes/:id` | Remove income |
| GET | `/api/incomes/summary?from=&to=` | Weekly income totals |

### Dashboard
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dashboard/summary` | Net worth, liquid, deltas, implied expenses |

## Expense calculation logic

```
implied_expenses = max(0, prev_liquid + week_income - current_liquid)
```

Income is recorded separately and subtracted from the liquid delta, so
salary arriving this week doesn't hide your actual spending.

## History

Until November 2026 this ran on Render with a Neon database and a magic-link login
(Resend), and the frontend on GitHub Pages (money.singledev.eu).
