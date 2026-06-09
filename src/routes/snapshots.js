import sql from '../db/index.js'

export default async function snapshotRoutes(fastify) {

  // GET /snapshots/latest — most recent balance for each active account
  fastify.get('/snapshots/latest', { preHandler: fastify.authenticate }, async (req, reply) => {
    const snapshots = await sql`
      SELECT DISTINCT ON (s.account_id)
        s.id, s.account_id, s.balance, s.recorded_at,
        a.name, a.type, a.is_active, a.sort_order
      FROM account_snapshots s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.user_id = ${req.user.id}
        AND a.is_active = TRUE
      ORDER BY s.account_id, s.recorded_at DESC
    `
    return reply.send({ snapshots })
  })

  // POST /snapshots — save weekly update (batch: one date, all accounts)
  // Body: { recorded_at: "2025-06-09", entries: [{ account_id, balance }] }
  fastify.post('/snapshots', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { recorded_at, entries } = req.body ?? {}

    if (!recorded_at || !Array.isArray(entries) || entries.length === 0) {
      return reply.code(400).send({ error: 'recorded_at and entries[] required' })
    }

    // Validate all account_ids belong to this user
    const accountIds = entries.map(e => e.account_id)
    const owned = await sql`
      SELECT id FROM accounts
      WHERE id = ANY(${accountIds}) AND user_id = ${req.user.id}
    `
    if (owned.length !== accountIds.length) {
      return reply.code(403).send({ error: 'One or more accounts not found' })
    }

    // Upsert all snapshots for this date
    const rows = entries.map(e => ({
      account_id: e.account_id,
      user_id: req.user.id,
      balance: e.balance,
      recorded_at
    }))

    const saved = await sql`
      INSERT INTO account_snapshots ${sql(rows, 'account_id', 'user_id', 'balance', 'recorded_at')}
      ON CONFLICT (account_id, recorded_at)
      DO UPDATE SET balance = EXCLUDED.balance
      RETURNING id, account_id, balance, recorded_at
    `

    return reply.code(201).send({ snapshots: saved })
  })

  // GET /snapshots/history?from=2025-01-01&to=2025-06-09
  // Returns all snapshots in range, grouped by date — used for charts
  fastify.get('/snapshots/history', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { from, to } = req.query

    if (!from || !to) {
      return reply.code(400).send({ error: 'from and to dates required (YYYY-MM-DD)' })
    }

    const snapshots = await sql`
      SELECT
        s.recorded_at,
        s.account_id,
        s.balance,
        a.name,
        a.type
      FROM account_snapshots s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.user_id = ${req.user.id}
        AND s.recorded_at BETWEEN ${from}::date AND ${to}::date
      ORDER BY s.recorded_at ASC, a.sort_order ASC
    `

    return reply.send({ snapshots })
  })
}
