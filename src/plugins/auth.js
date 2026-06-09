import fp from 'fastify-plugin'
import sql from '../db/index.js'

async function authPlugin(fastify) {
  fastify.decorate('authenticate', async function (req, reply) {
    const authHeader = req.headers['authorization'] ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

    if (!token) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const [session] = await sql`
      SELECT s.id, s.token, s.user_id, s.expires_at, u.email
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ${token}
        AND s.expires_at > NOW()
    `

    if (!session) {
      return reply.code(401).send({ error: 'Session expired or invalid' })
    }

    req.user = { id: session.user_id, email: session.email }
    req.sessionToken = session.token
  })
}

export default fp(authPlugin)
