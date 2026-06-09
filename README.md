# money-tracker-api

Backend for money.singledev.eu — personal finance tracker.

## Stack
- Node.js + Fastify 5
- Neon PostgreSQL
- Resend (magic link auth)
- Hosted on Render

## Setup

### 1. Create Neon database

1. Go to [neon.tech](https://neon.tech) → New project
2. Name it `money-tracker`, region `EU Central (Frankfurt)`
3. Go to **SQL Editor** → paste and run the contents of `schema.sql`
4. Go to **Connection Details** → copy the **Connection string**

### 2. Configure Resend

Use your existing Resend account (already set up for singledev.eu).
Create a new API key (or reuse the parking service one).

### 3. Local development

```bash
cp .env.example .env
# Fill in DATABASE_URL, RESEND_API_KEY, ALLOWED_EMAIL
npm install
npm run dev
```

Server runs on http://localhost:3000

### 4. Deploy to Render

1. Push repo to GitHub as `money-tracker-api`
2. Render → New Web Service → connect repo
3. Settings:
   - **Runtime**: Node
   - **Build command**: `npm install`
   - **Start command**: `node src/index.js`
   - **Region**: Frankfurt (EU)
4. Environment variables (add all from `.env.example`):
   - `DATABASE_URL` — from Neon
   - `RESEND_API_KEY` — from Resend
   - `ALLOWED_EMAIL` — your email
   - `FRONTEND_URL` — `https://money.singledev.eu`
   - `ALLOWED_ORIGIN` — `https://money.singledev.eu`

## API Reference

### Auth (no token required)
| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/auth/request` | `{ email }` | Send magic link |
| POST | `/auth/verify` | `{ token }` | Exchange token → session |
| POST | `/auth/logout` | — | Invalidate session |
| GET | `/auth/me` | — | Current user |

### Accounts (Bearer token required)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounts` | List all accounts |
| POST | `/api/accounts` | Create account `{ name, type }` |
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
