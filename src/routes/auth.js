import { nanoid } from 'nanoid'
import { Resend } from 'resend'
import sql from '../db/index.js'

const resend = new Resend(process.env.RESEND_API_KEY)

const ALLOWED_EMAILS = (process.env.ALLOWED_EMAIL || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean)

// The first email in ALLOWED_EMAIL is treated as the shared/canonical account.
// Every allowed email logs into the SAME user_id, so everyone sees the same data.
const CANONICAL_EMAIL = ALLOWED_EMAILS[0]

// TEMP DEBUG: log the parsed allow-list once at boot, with raw char codes
// so hidden whitespace/newlines are visible. Remove once the login bug is fixed.
console.log('[DEBUG] raw ALLOWED_EMAIL env:', JSON.stringify(process.env.ALLOWED_EMAIL))
console.log('[DEBUG] parsed ALLOWED_EMAILS:', JSON.stringify(ALLOWED_EMAILS))
ALLOWED_EMAILS.forEach((e, i) => {
  console.log(`[DEBUG] ALLOWED_EMAILS[${i}] char codes:`, Array.from(e).map(c => c.charCodeAt(0)))
})

const SESSION_TTL_DAYS = 30
const MAGIC_LINK_TTL_MINUTES = 15

export default async function authRoutes(fastify) {

  // POST /auth/request — send magic link
  fastify.post('/auth/request', async (req, reply) => {
    const { email } = req.body ?? {}
    if (!email || typeof email !== 'string') {
      return reply.code(400).send({ error: 'Email required' })
    }

    const requestedEmail = email.toLowerCase().trim()

    // TEMP DEBUG: log exactly what we received and compared against.
    // Remove once the login bug is fixed.
    req.log.info({
      rawEmail: email,
      requestedEmail,
      requestedEmailCharCodes: Array.from(requestedEmail).map(c => c.charCodeAt(0)),
      allowedEmails: ALLOWED_EMAILS,
      isMatch: ALLOWED_EMAILS.includes(requestedEmail)
    }, 'DEBUG auth/request email comparison')

    // Only allowed emails
    if (!ALLOWED_EMAILS.includes(requestedEmail)) {
      // Return 200 anyway to avoid email enumeration
      return reply.send({ ok: true })
    }

    // Everyone in ALLOWED_EMAILS shares the same underlying account/user_id
    const [user] = await sql`
      INSERT INTO users (email)
      VALUES (${CANONICAL_EMAIL})
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id
    `

    const token = nanoid(48)
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000)

    await sql`
      INSERT INTO magic_links (user_id, token, expires_at)
      VALUES (${user.id}, ${token}, ${expiresAt})
    `

    const magicUrl = `${process.env.FRONTEND_URL}/auth/verify?token=${token}`

    const { data, error } = await resend.emails.send({
      from: `Money Tracker <hello@singledev.eu>`,
      to: email,
      subject: 'Your sign-in link',
      html: `
        <p>Click the link below to sign in. It expires in ${MAGIC_LINK_TTL_MINUTES} minutes.</p>
        <p><a href="${magicUrl}">${magicUrl}</a></p>
        <p style="color:#888;font-size:12px;">If you didn't request this, ignore this email.</p>
      `
    })

    if (error) {
      req.log.error({ error }, 'Resend send failed')
      return reply.code(500).send({ error: 'Failed to send email' })
    }

    req.log.info({ resendId: data?.id }, 'Magic link email sent')

    return reply.send({ ok: true })
  })

  // POST /auth/verify — exchange token for session
  fastify.post('/auth/verify', async (req, reply) => {
    const { token } = req.body ?? {}
    if (!token) return reply.code(400).send({ error: 'Token required' })

    const [link] = await sql`
      SELECT ml.*, u.email
      FROM magic_links ml
      JOIN users u ON u.id = ml.user_id
      WHERE ml.token = ${token}
        AND ml.used_at IS NULL
        AND ml.expires_at > NOW()
    `

    if (!link) {
      return reply.code(401).send({ error: 'Invalid or expired link' })
    }

    // Mark link as used
    await sql`
      UPDATE magic_links SET used_at = NOW() WHERE id = ${link.id}
    `

    // Create session
    const sessionToken = nanoid(64)
    const sessionExpiry = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)

    await sql`
      INSERT INTO sessions (user_id, token, expires_at)
      VALUES (${link.user_id}, ${sessionToken}, ${sessionExpiry})
    `

    return reply.send({
      session_token: sessionToken,
      expires_at: sessionExpiry,
      email: link.email
    })
  })

  // POST /auth/logout
  fastify.post('/auth/logout', { preHandler: fastify.authenticate }, async (req, reply) => {
    await sql`DELETE FROM sessions WHERE token = ${req.sessionToken}`
    return reply.send({ ok: true })
  })

  // GET /auth/me
  fastify.get('/auth/me', { preHandler: fastify.authenticate }, async (req, reply) => {
    return reply.send({ user: req.user })
  })
}
