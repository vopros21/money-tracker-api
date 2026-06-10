import Fastify from 'fastify'
import cors from '@fastify/cors'
import { nanoid } from 'nanoid'
import { Resend } from 'resend'
import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)
const resend = new Resend(process.env.RESEND_API_KEY)

const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL
const FRONTEND_URL = process.env.FRONTEND_URL
const SESSION_TTL_DAYS = 30
const MAGIC_LINK_TTL_MINUTES = 15

const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })

await fastify.register(cors, {
  origin: process.env.ALLOWED_ORIGIN ?? '*',
  credentials: true
})

// Auth middleware
fastify.decorate('authenticate', async function (req, reply) {
  const authHeader = req.headers['authorization'] ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return reply.code(401).send({ error: 'Unauthorized' })

  const [session] = await sql`
    SELECT s.user_id, s.token, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > NOW()
  `
  if (!session) return reply.code(401).send({ error: 'Session expired or invalid' })

  req.user = { id: session.user_id, email: session.email }
  req.sessionToken = session.token
})

// ── HEALTH ──────────────────────────────────────────────
fastify.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }))

// ── AUTH ─────────────────────────────────────────────────
fastify.post('/auth/request', async (req, reply) => {
  const { email } = req.body ?? {}
  if (!email) return reply.code(400).send({ error: 'Email required' })
  if (email.toLowerCase().trim() !== ALLOWED_EMAIL.toLowerCase()) return reply.send({ ok: true })

  const [user] = await sql`
    INSERT INTO users (email) VALUES (${email.toLowerCase().trim()})
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
    RETURNING id
  `
  const token = nanoid(48)
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000)
  await sql`INSERT INTO magic_links (user_id, token, expires_at) VALUES (${user.id}, ${token}, ${expiresAt})`

  const magicUrl = `${FRONTEND_URL}/auth/verify?token=${token}`
  await resend.emails.send({
    from: 'Money Tracker <hello@singledev.eu>',
    to: email,
    subject: 'Your sign-in link',
    html: `<p>Sign in link (expires in ${MAGIC_LINK_TTL_MINUTES} min):</p><p><a href="${magicUrl}">${magicUrl}</a></p>`
  })
  return reply.send({ ok: true })
})

fastify.post('/auth/verify', async (req, reply) => {
  const { token } = req.body ?? {}
  if (!token) return reply.code(400).send({ error: 'Token required' })

  const [link] = await sql`
    SELECT ml.*, u.email FROM magic_links ml JOIN users u ON u.id = ml.user_id
    WHERE ml.token = ${token} AND ml.used_at IS NULL AND ml.expires_at > NOW()
  `
  if (!link) return reply.code(401).send({ error: 'Invalid or expired link' })

  await sql`UPDATE magic_links SET used_at = NOW() WHERE id = ${link.id}`

  const sessionToken = nanoid(64)
  const sessionExpiry = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
  await sql`INSERT INTO sessions (user_id, token, expires_at) VALUES (${link.user_id}, ${sessionToken}, ${sessionExpiry})`

  return reply.send({ session_token: sessionToken, expires_at: sessionExpiry, email: link.email })
})

fastify.post('/auth/logout', { preHandler: fastify.authenticate }, async (req, reply) => {
  await sql`DELETE FROM sessions WHERE token = ${req.sessionToken}`
  return reply.send({ ok: true })
})

fastify.get('/auth/me', { preHandler: fastify.authenticate }, async (req, reply) => {
  return reply.send({ user: req.user })
})

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
  if (!from || !to) return reply.code(400).send({ error: 'from and to required' })
  const snapshots = await sql`
    SELECT s.recorded_at, s.account_id, s.balance, a.name, a.type
    FROM account_snapshots s JOIN accounts a ON a.id = s.account_id
    WHERE s.user_id = ${req.user.id} AND s.recorded_at BETWEEN ${from}::date AND ${to}::date
    ORDER BY s.recorded_at ASC, a.sort_order ASC
  `
  return reply.send({ snapshots })
})

// ── INCOMES ───────────────────────────────────────────────
fastify.get('/api/incomes', { preHandler: fastify.authenticate }, async (req, reply) => {
  const { from, to, limit = 50 } = req.query
  const incomes = from && to
    ? await sql`SELECT id, amount, source, note, received_at FROM incomes WHERE user_id=${req.user.id} AND received_at BETWEEN ${from}::date AND ${to}::date ORDER BY received_at DESC LIMIT ${parseInt(limit)}`
    : await sql`SELECT id, amount, source, note, received_at FROM incomes WHERE user_id=${req.user.id} ORDER BY received_at DESC LIMIT ${parseInt(limit)}`
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
    SELECT DISTINCT ON (s.account_id) s.account_id, s.balance, s.recorded_at, a.type
    FROM account_snapshots s JOIN accounts a ON a.id = s.account_id
    WHERE s.user_id=${userId} AND a.is_active=TRUE ORDER BY s.account_id, s.recorded_at DESC
  `
  const prev = await sql`
    SELECT DISTINCT ON (s.account_id) s.account_id, s.balance, s.recorded_at, a.type
    FROM account_snapshots s JOIN accounts a ON a.id = s.account_id
    WHERE s.user_id=${userId} AND a.is_active=TRUE
      AND s.recorded_at < (SELECT MAX(recorded_at) FROM account_snapshots WHERE user_id=${userId})
    ORDER BY s.account_id, s.recorded_at DESC
  `

  function totals(snaps) {
    let netWorth = 0, liquid = 0
    const restricted = []
    for (const s of snaps) {
      const b = parseFloat(s.balance)
      if (s.type === 'credit' || s.type === 'debt') {
        netWorth -= b
      } else {
        netWorth += b
        if (s.type === 'debit' || s.type === 'cash') liquid += b
        if (s.type === 'restricted') restricted.push({ name: s.name, balance: b })
      }
    }
    return { netWorth, liquid, restricted }
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
    net_worth_delta: Math.round((cur.netWorth - prv.netWorth) * 100) / 100,
    liquid_delta: Math.round((cur.liquid - prv.liquid) * 100) / 100,
    week_income: Math.round(weekIncome * 100) / 100,
    implied_expenses: Math.round(Math.max(0, prv.liquid + weekIncome - cur.liquid) * 100) / 100,
    last_update: latest[0]?.recorded_at ?? null,
    restricted: cur.restricted   // ← new
  })
})

// ── START ─────────────────────────────────────────────────
try {
  await fastify.listen({ port: parseInt(process.env.PORT ?? '3000'), host: '0.0.0.0' })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
