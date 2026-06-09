import sql from '../db/index.js'

export default async function incomeRoutes(fastify) {

  // GET /incomes?from=2025-01-01&to=2025-06-09&limit=50
  fastify.get('/incomes', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { from, to, limit = 50 } = req.query

    let incomes
    if (from && to) {
      incomes = await sql`
        SELECT id, amount, source, note, received_at, created_at
        FROM incomes
        WHERE user_id = ${req.user.id}
          AND received_at BETWEEN ${from}::date AND ${to}::date
        ORDER BY received_at DESC
        LIMIT ${parseInt(limit)}
      `
    } else {
      incomes = await sql`
        SELECT id, amount, source, note, received_at, created_at
        FROM incomes
        WHERE user_id = ${req.user.id}
        ORDER BY received_at DESC
        LIMIT ${parseInt(limit)}
      `
    }

    return reply.send({ incomes })
  })

  // POST /incomes — log income
  fastify.post('/incomes', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { amount, source, note, received_at } = req.body ?? {}

    if (!amount || !source || !received_at) {
      return reply.code(400).send({ error: 'amount, source, and received_at required' })
    }
    if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return reply.code(400).send({ error: 'amount must be a positive number' })
    }

    const [income] = await sql`
      INSERT INTO incomes (user_id, amount, source, note, received_at)
      VALUES (${req.user.id}, ${amount}, ${source}, ${note ?? null}, ${received_at})
      RETURNING id, amount, source, note, received_at, created_at
    `

    return reply.code(201).send({ income })
  })

  // DELETE /incomes/:id — remove a logged income
  fastify.delete('/incomes/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const incomeId = parseInt(req.params.id)

    const [deleted] = await sql`
      DELETE FROM incomes
      WHERE id = ${incomeId} AND user_id = ${req.user.id}
      RETURNING id
    `

    if (!deleted) return reply.code(404).send({ error: 'Income not found' })
    return reply.send({ ok: true })
  })

  // GET /incomes/summary?from=2025-01-01&to=2025-06-09
  // Returns total income per week — used for expense calculation in charts
  fastify.get('/incomes/summary', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { from, to } = req.query
    if (!from || !to) {
      return reply.code(400).send({ error: 'from and to required' })
    }

    const summary = await sql`
      SELECT
        DATE_TRUNC('week', received_at)::date AS week_start,
        SUM(amount) AS total
      FROM incomes
      WHERE user_id = ${req.user.id}
        AND received_at BETWEEN ${from}::date AND ${to}::date
      GROUP BY week_start
      ORDER BY week_start ASC
    `

    return reply.send({ summary })
  })
}
