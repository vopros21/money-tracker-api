import pg from 'pg'

// The API has no login, so it must only ever talk to a database on this
// machine. This stops it from serving the data openly if it gets deployed
// somewhere public by mistake (e.g. a Render auto-deploy still pointing at Neon).
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]'])
let dbHost
try {
  dbHost = new URL(process.env.DATABASE_URL ?? '').hostname
} catch {
  console.error('DATABASE_URL is missing or invalid')
  process.exit(1)
}
if (!LOCAL_HOSTS.has(dbHost) && process.env.ALLOW_REMOTE_DATABASE !== '1') {
  console.error(`Refusing to start: DATABASE_URL points at "${dbHost}", not a local database. ` +
    'This API has no authentication and is meant for the home LAN only.')
  process.exit(1)
}

// Local Postgres via node-postgres. Exposes the same tagged-template API the
// app used with @neondatabase/serverless: `await sql\`... ${v}\`` → rows[].
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 })

// An idle client erroring (e.g. Postgres restarting) must not crash the process.
pool.on('error', err => console.error('Postgres pool error:', err.message))

export async function sql(strings, ...values) {
  const text = strings[0] + values.map((_, i) => `$${i + 1}${strings[i + 1]}`).join('')
  const { rows } = await pool.query(text, values)
  return rows
}

export default sql
