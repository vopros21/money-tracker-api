import sql from '../db/index.js'

export default async function dashboardRoutes(fastify) {

  // GET /dashboard/summary
  // Returns: net_worth, liquid, and week-over-week deltas
  fastify.get('/dashboard/summary', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = req.user.id

    // Latest snapshot per account
    const latestSnapshots = await sql`
      SELECT DISTINCT ON (s.account_id)
        s.account_id, s.balance, s.recorded_at, a.type
      FROM account_snapshots s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.user_id = ${userId} AND a.is_active = TRUE
      ORDER BY s.account_id, s.recorded_at DESC
    `

    // Previous week snapshot per account (second most recent)
    const prevSnapshots = await sql`
      SELECT DISTINCT ON (s.account_id)
        s.account_id, s.balance, s.recorded_at, a.type
      FROM account_snapshots s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.user_id = ${userId}
        AND a.is_active = TRUE
        AND s.recorded_at < (
          SELECT MAX(recorded_at) FROM account_snapshots WHERE user_id = ${userId}
        )
      ORDER BY s.account_id, s.recorded_at DESC
    `

    function computeTotals(snapshots) {
      let netWorth = 0
      let liquid = 0
      for (const s of snapshots) {
        const b = parseFloat(s.balance)
        if (s.type === 'credit' || s.type === 'debt') {
          netWorth -= b
        } else {
          netWorth += b
        }
        if (s.type === 'debit' || s.type === 'cash') {
          liquid += b
        }
      }
      return { netWorth, liquid }
    }

    const current = computeTotals(latestSnapshots)
    const previous = computeTotals(prevSnapshots)

    // Income this week
    const latestDate = latestSnapshots[0]?.recorded_at
    let weekIncome = 0
    if (latestDate) {
      const weekStart = new Date(latestDate)
      weekStart.setDate(weekStart.getDate() - 7)
      const [incomeRow] = await sql`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM incomes
        WHERE user_id = ${userId}
          AND received_at BETWEEN ${weekStart.toISOString().slice(0,10)}::date
          AND ${latestDate}::date
      `
      weekIncome = parseFloat(incomeRow?.total ?? 0)
    }

    // Implied expenses = (prev liquid + income this week) - current liquid
    const impliedExpenses = Math.max(0, previous.liquid + weekIncome - current.liquid)

    return reply.send({
      net_worth: Math.round(current.netWorth * 100) / 100,
      liquid: Math.round(current.liquid * 100) / 100,
      net_worth_delta: Math.round((current.netWorth - previous.netWorth) * 100) / 100,
      liquid_delta: Math.round((current.liquid - previous.liquid) * 100) / 100,
      week_income: Math.round(weekIncome * 100) / 100,
      implied_expenses: Math.round(impliedExpenses * 100) / 100,
      last_update: latestSnapshots[0]?.recorded_at ?? null
    })
  })
}
