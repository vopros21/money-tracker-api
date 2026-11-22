import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import path from 'node:path'
import sql from './db/index.js'

const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })

// No login: the app runs on the home LAN only. Every request acts as the
// single existing user (the one the data was created under).
let ownerId = null
async function resolveOwner() {
  if (ownerId) return ownerId
  const [u] = await sql`SELECT id FROM users ORDER BY id LIMIT 1`
  if (u) return (ownerId = u.id)
  const [created] = await sql`INSERT INTO users (email) VALUES ('owner@local') RETURNING id`
  return (ownerId = created.id)
}

fastify.decorate('authenticate', async function (req) {
  req.user = { id: await resolveOwner() }
})

// ── HEALTH ──────────────────────────────────────────────
fastify.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }))

// ── ACCOUNTS ──────────────────────────────────────────────
fastify.get('/api/accounts', { preHandler: fastify.authenticate }, async (req, reply) => {
  const accounts = await sql`
    SELECT id, name, type, is_active, sort_order, created_at FROM accounts
    WHERE user_id = ${req.user.id} ORDER BY name ASC
  `
  return reply.send({ accounts })
})

fastify.post('/api/accounts', { preHandler: fastify.authenticate }, async (req, reply) => {
  const { name, type, sort_order = 0 } = req.body ?? {}
  if (!name || !type) return reply.code(400).send({ error: 'name and type required' })
  const validTypes = ['debit', 'credit', 'debt', 'investment', 'cash', 'restricted']
  if (!validTypes.includes(type)) return reply.code(400).send({ error: `type must be one of: ${validTypes.join(', ')}` })

  const [account] = await sql`
    INSERT INTO accounts (user_id, name, type, sort_order) VALUES (${req.user.id}, ${name}, ${type}, ${sort_order})
    RETURNING id, name, type, is_active, sort_order, created_at
  `
  return reply.code(201).send({ account })
})

fastify.patch('/api/accounts/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
  const { name, is_active } = req.body ?? {}
  const id = parseInt(req.params.id)

  if (name !== undefined && is_active !== undefined) {
    const [a] = await sql`UPDATE accounts SET name=${name}, is_active=${is_active} WHERE id=${id} AND user_id=${req.user.id} RETURNING id, name, type, is_active`
    return a ? reply.send({ account: a }) : reply.code(404).send({ error: 'Not found' })
  } else if (name !== undefined) {
    const [a] = await sql`UPDATE accounts SET name=${name} WHERE id=${id} AND user_id=${req.user.id} RETURNING id, name, type, is_active`
    return a ? reply.send({ account: a }) : reply.code(404).send({ error: 'Not found' })
  } else if (is_active !== undefined) {
    const [a] = await sql`UPDATE accounts SET is_active=${is_active} WHERE id=${id} AND user_id=${req.user.id} RETURNING id, name, type, is_active`
    return a ? reply.send({ account: a }) : reply.code(404).send({ error: 'Not found' })
  }
  return reply.code(400).send({ error: 'Nothing to update' })
})

// ── SNAPSHOTS ─────────────────────────────────────────────
fastify.get('/api/snapshots/latest', { preHandler: fastify.authenticate }, async (req, reply) => {
  const snapshots = await sql`
    SELECT DISTINCT ON (s.account_id)
      s.id, s.account_id, s.balance, s.recorded_at, a.name, a.type, a.is_active, a.sort_order
    FROM account_snapshots s JOIN accounts a ON a.id = s.account_id
    WHERE s.user_id = ${req.user.id} AND a.is_active = TRUE
    ORDER BY s.account_id, s.recorded_at DESC
  `
  return reply.send({ snapshots })
})

fastify.post('/api/snapshots', { preHandler: fastify.authenticate }, async (req, reply) => {
  const { recorded_at, entries } = req.body ?? {}
  if (!recorded_at || !Array.isArray(entries) || entries.length === 0)
    return reply.code(400).send({ error: 'recorded_at and entries[] required' })

  const saved = []
  for (const e of entries) {
    const [s] = await sql`
      INSERT INTO account_snapshots (account_id, user_id, balance, recorded_at)
      VALUES (${e.account_id}, ${req.user.id}, ${e.balance}, ${recorded_at})
      ON CONFLICT (account_id, recorded_at) DO UPDATE SET balance = EXCLUDED.balance
      RETURNING id, account_id, balance, recorded_at
    `
    saved.push(s)
  }
  return reply.code(201).send({ snapshots: saved })
})

fastify.get('/api/snapshots/history', { preHandler: fastify.authenticate }, async (req, reply) => {
  const { from, to } = req.query
  // `to` is still required; `from` is optional so the "All" period tab can
  // request full history. An empty string (from=) is treated as absent.
  if (!to) return reply.code(400).send({ error: 'to required' })
  const snapshots = from
    ? await sql`
        SELECT s.recorded_at, s.account_id, s.balance, a.name, a.type
        FROM account_snapshots s JOIN accounts a ON a.id = s.account_id
        WHERE s.user_id = ${req.user.id} AND s.recorded_at BETWEEN ${from}::date AND ${to}::date
        ORDER BY s.recorded_at ASC, a.sort_order ASC
      `
    : await sql`
        SELECT s.recorded_at, s.account_id, s.balance, a.name, a.type
        FROM account_snapshots s JOIN accounts a ON a.id = s.account_id
        WHERE s.user_id = ${req.user.id} AND s.recorded_at <= ${to}::date
        ORDER BY s.recorded_at ASC, a.sort_order ASC
      `
  return reply.send({ snapshots })
})

// ── INCOMES ───────────────────────────────────────────────
fastify.get('/api/incomes', { preHandler: fastify.authenticate }, async (req, reply) => {
  const { from, to, limit = 50 } = req.query
  // `from` optional (empty string treated as absent) so the "All" period can
  // pull full history; still bound by `to` when provided.
  const lim = parseInt(limit)
  let incomes
  if (from && to) {
    incomes = await sql`SELECT id, amount, source, note, received_at FROM incomes WHERE user_id=${req.user.id} AND received_at BETWEEN ${from}::date AND ${to}::date ORDER BY received_at DESC LIMIT ${lim}`
  } else if (to) {
    incomes = await sql`SELECT id, amount, source, note, received_at FROM incomes WHERE user_id=${req.user.id} AND received_at <= ${to}::date ORDER BY received_at DESC LIMIT ${lim}`
  } else {
    incomes = await sql`SELECT id, amount, source, note, received_at FROM incomes WHERE user_id=${req.user.id} ORDER BY received_at DESC LIMIT ${lim}`
  }
  return reply.send({ incomes })
})

fastify.post('/api/incomes', { preHandler: fastify.authenticate }, async (req, reply) => {
  const { amount, source, note, received_at } = req.body ?? {}
  if (!amount || !source || !received_at) return reply.code(400).send({ error: 'amount, source, received_at required' })
  const [income] = await sql`
    INSERT INTO incomes (user_id, amount, source, note, received_at)
    VALUES (${req.user.id}, ${amount}, ${source}, ${note ?? null}, ${received_at})
    RETURNING id, amount, source, note, received_at
  `
  return reply.code(201).send({ income })
})

fastify.delete('/api/incomes/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
  const [d] = await sql`DELETE FROM incomes WHERE id=${parseInt(req.params.id)} AND user_id=${req.user.id} RETURNING id`
  return d ? reply.send({ ok: true }) : reply.code(404).send({ error: 'Not found' })
})

fastify.get('/api/incomes/summary', { preHandler: fastify.authenticate }, async (req, reply) => {
  const { from, to } = req.query
  if (!from || !to) return reply.code(400).send({ error: 'from and to required' })
  const summary = await sql`
    SELECT DATE_TRUNC('week', received_at)::date AS week_start, SUM(amount) AS total
    FROM incomes WHERE user_id=${req.user.id} AND received_at BETWEEN ${from}::date AND ${to}::date
    GROUP BY week_start ORDER BY week_start ASC
  `
  return reply.send({ summary })
})

// ── DASHBOARD ─────────────────────────────────────────────
fastify.get('/api/dashboard/summary', { preHandler: fastify.authenticate }, async (req, reply) => {
  const userId = req.user.id

  const latest = await sql`
    SELECT DISTINCT ON (s.account_id) s.account_id, s.balance, s.recorded_at, a.type, a.name
    FROM account_snapshots s JOIN accounts a ON a.id = s.account_id
    WHERE s.user_id=${userId} AND a.is_active=TRUE ORDER BY s.account_id, s.recorded_at DESC
  `
  const prev = await sql`
    SELECT DISTINCT ON (s.account_id) s.account_id, s.balance, s.recorded_at, a.type, a.name
    FROM account_snapshots s JOIN accounts a ON a.id = s.account_id
    WHERE s.user_id=${userId} AND a.is_active=TRUE
      AND s.recorded_at < (SELECT MAX(recorded_at) FROM account_snapshots WHERE user_id=${userId})
    ORDER BY s.account_id, s.recorded_at DESC
  `

  function totals(snaps) {
    let netWorth = 0, liquid = 0, debt = 0, invest = 0
    const restricted = []
    for (const s of snaps) {
      const b = parseFloat(s.balance)
      if (s.type === 'credit' || s.type === 'debt') {
        netWorth -= b
        debt += b
      } else {
        netWorth += b
        if (s.type === 'debit' || s.type === 'cash') liquid += b
        if (s.type === 'investment') invest += b
        if (s.type === 'restricted') restricted.push({ name: s.name, balance: b })
      }
    }
    return { netWorth, liquid, debt, invest, restricted }
  }

  const cur = totals(latest)
  const prv = totals(prev)

  const latestDate = latest[0]?.recorded_at
  let weekIncome = 0
  if (latestDate) {
    const weekStart = new Date(latestDate)
    weekStart.setDate(weekStart.getDate() - 7)
    const [r] = await sql`
      SELECT COALESCE(SUM(amount),0) AS total FROM incomes
      WHERE user_id=${userId} AND received_at BETWEEN ${weekStart.toISOString().slice(0, 10)}::date AND ${latestDate}::date
    `
    weekIncome = parseFloat(r?.total ?? 0)
  }

  return reply.send({
    net_worth: Math.round(cur.netWorth * 100) / 100,
    liquid: Math.round(cur.liquid * 100) / 100,
    debt: Math.round(cur.debt * 100) / 100,
    investments: Math.round(cur.invest * 100) / 100,
    net_worth_delta: Math.round((cur.netWorth - prv.netWorth) * 100) / 100,
    liquid_delta: Math.round((cur.liquid - prv.liquid) * 100) / 100,
    debt_delta: Math.round((cur.debt - prv.debt) * 100) / 100,
    investments_delta: Math.round((cur.invest - prv.invest) * 100) / 100,
    week_income: Math.round(weekIncome * 100) / 100,
    implied_expenses: Math.round(Math.max(0, prv.liquid + weekIncome - cur.liquid) * 100) / 100,
    last_update: latest[0]?.recorded_at ?? null,
    restricted: cur.restricted
  })
})

// ── FRONTEND (optional) ───────────────────────────────────
// When STATIC_DIR points at the frontend's dist/, serve the SPA from the same
// origin so the whole app runs as one service on the home network.
if (process.env.STATIC_DIR) {
  await fastify.register(fastifyStatic, { root: path.resolve(process.env.STATIC_DIR) })
  // SPA fallback: client-side routes (/dashboard, /income…) get index.html.
  // API paths and missing files with an extension (/assets/x.js) stay 404.
  fastify.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0]
    const isPage = (req.method === 'GET' || req.method === 'HEAD') &&
      !pathname.startsWith('/api/') && !path.extname(pathname)
    if (isPage) return reply.sendFile('index.html')
    return reply.code(404).send({ error: 'Not found' })
  })
}

// ── START ─────────────────────────────────────────────────
try {
  await fastify.listen({ port: parseInt(process.env.PORT ?? '3000'), host: '0.0.0.0' })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
