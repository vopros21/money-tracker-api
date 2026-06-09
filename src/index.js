import Fastify from 'fastify'
import cors from '@fastify/cors'

import authPlugin from './plugins/auth.js'
import authRoutes from './routes/auth.js'
import accountRoutes from './routes/accounts.js'
import snapshotRoutes from './routes/snapshots.js'
import incomeRoutes from './routes/incomes.js'
import dashboardRoutes from './routes/dashboard.js'

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info'
  }
})

await fastify.register(cors, {
  origin: process.env.ALLOWED_ORIGIN ?? '*',
  credentials: true
})

// Session auth decorator
await fastify.register(authPlugin)

// Routes
await fastify.register(authRoutes, { prefix: '/auth' })
await fastify.register(accountRoutes, { prefix: '/api' })
await fastify.register(snapshotRoutes, { prefix: '/api' })
await fastify.register(incomeRoutes, { prefix: '/api' })
await fastify.register(dashboardRoutes, { prefix: '/api' })

// Health check
fastify.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }))

const PORT = parseInt(process.env.PORT ?? '3000')
const HOST = process.env.HOST ?? '0.0.0.0'

try {
  await fastify.listen({ port: PORT, host: HOST })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
