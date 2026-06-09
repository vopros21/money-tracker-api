import sql from '../db/index.js'

export default async function accountRoutes(fastify) {

  // GET /accounts — list all active accounts
  fastify.get('/accounts', { preHandler: fastify.authenticate }, async (req, reply) => {
    const accounts = await sql`
      SELECT id, name, type, is_active, sort_order, created_at
      FROM accounts
      WHERE user_id = ${req.user.id}
      ORDER BY sort_order ASC, created_at ASC
    `
    return reply.send({ accounts })
  })

  // POST /accounts — create account
  fastify.post('/accounts', { preHandler: fastify.authenticate }, async (req, reply) => {
    const { name, type, sort_order = 0 } = req.body ?? {}

    if (!name || !type) {
      return reply.code(400).send({ error: 'name and type required' })
    }
    const validTypes = ['debit', 'credit', 'debt', 'investment', 'cash']
    if (!validTypes.includes(type)) {
      return reply.code(400).send({ error: `type must be one of: ${validTypes.join(', ')}` })
    }

    const [account] = await sql`
      INSERT INTO accounts (user_id, name, type, sort_order)
      VALUES (${req.user.id}, ${name}, ${type}, ${sort_order})
      RETURNING id, name, type, is_active, sort_order, created_at
    `
    return reply.code(201).send({ account })
  })

  // PATCH /accounts/:id — rename or archive
  fastify.patch('/accounts/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const accountId = parseInt(req.params.id)
    const { name, is_active, sort_order } = req.body ?? {}

    const updates = []
    if (name !== undefined) updates.push(sql`name = ${name}`)
    if (is_active !== undefined) updates.push(sql`is_active = ${is_active}`)
    if (sort_order !== undefined) updates.push(sql`sort_order = ${sort_order}`)

    if (updates.length === 0) {
      return reply.code(400).send({ error: 'Nothing to update' })
    }

    const [account] = await sql`
      UPDATE accounts
      SET ${sql(updates.join(', '))}
      WHERE id = ${accountId} AND user_id = ${req.user.id}
      RETURNING id, name, type, is_active, sort_order
    `

    if (!account) return reply.code(404).send({ error: 'Account not found' })
    return reply.send({ account })
  })
}
