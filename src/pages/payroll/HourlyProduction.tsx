import './SummaryReport.css'
import './HourlyProduction.css'

/**
 * Mock-data hourly production dashboard for FFB Reception. Visual merge
 * only — placeholder numbers until an hourly production_entries breakdown
 * exists in Supabase. Reuses the pr-summary design tokens and component
 * classes already defined in SummaryReport.css.
 */

interface HourBucket {
  label: string
  cages: number
  workers: number
  lunch?: boolean
}

const HOURLY: HourBucket[] = [
  { label: '6–7 AM', cages: 22, workers: 5 },
  { label: '7–8 AM', cages: 34, workers: 7 },
  { label: '8–9 AM', cages: 41, workers: 8 },
  { label: '9–10 AM', cages: 39, workers: 8 },
  { label: '10–11 AM', cages: 36, workers: 7 },
  { label: '11–12 PM', cages: 30, workers: 6 },
  { label: '12–1 PM', cages: 12, workers: 3, lunch: true },
  { label: '1–2 PM', cages: 28, workers: 6 },
  { label: '2–3 PM', cages: 35, workers: 7 },
  { label: '3–4 PM', cages: 39, workers: 8 },
  { label: '4–5 PM', cages: 43, workers: 8 },
  { label: '5–6 PM', cages: 28, workers: 6 },
]

const totalCages = HOURLY.reduce((s, h) => s + h.cages, 0)
const maxCages = Math.max(...HOURLY.map((h) => h.cages))
const peak = HOURLY.reduce((best, h) => (h.cages > best.cages ? h : best), HOURLY[0])
const avgPerHour = totalCages / HOURLY.length

const num = (n: number) => n.toLocaleString('en-US')

export default function HourlyProduction() {
  return (
    <div className="pr-summary">
      <div className="pr-kpi-grid">
        <KpiCard icon={<BarsIcon />} label="Cages Tipped Today" value={num(totalCages)} foot="23 Jul 2026 · FFB Reception" />
        <KpiCard icon={<ClockIcon />} label="Peak Hour" value={peak.label} foot={`${peak.cages} cages tipped`} />
        <KpiCard icon={<TrendIcon />} label="Avg Cages / Hour" value={avgPerHour.toFixed(1)} foot="across 12 operating hours" />
        <KpiCard icon={<PeopleIcon />} label="Active Workers" value="8 / 12" foot="currently clocked in" />
      </div>

      <div className="pr-chart-card">
        <div className="pr-chart-title">Cages Tipped by Hour — Today</div>
        <div className="pr-hourly-chart">
          {HOURLY.map((h) => (
            <div className={`pr-hourly-col${h.lunch ? ' lunch' : ''}`} key={h.label}>
              <div className="pr-hourly-value">{h.cages}</div>
              <div className="pr-hourly-track">
                <div className="pr-hourly-bar" style={{ height: `${(h.cages / maxCages) * 100}%` }} />
              </div>
              <div className="pr-hourly-label">{h.label.replace(' AM', 'A').replace(' PM', 'P')}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="pr-table-card">
        <div className="pr-table-card-head">
          <h3>Hourly Breakdown</h3>
          <span className="muted small">23 Jul 2026 · FFB Reception</span>
        </div>
        <div className="pr-table-scroll">
          <table className="pr-data">
            <thead>
              <tr>
                <th>Hour</th><th className="right">Cages Tipped</th>
                <th className="right">Workers Active</th><th className="right">Avg / Worker</th>
              </tr>
            </thead>
            <tbody>
              {HOURLY.map((h) => (
                <tr key={h.label} className={h.lunch ? 'pr-lunch-row' : undefined}>
                  <td>{h.label}{h.lunch ? ' (lunch)' : ''}</td>
                  <td className="right">{h.cages}</td>
                  <td className="right">{h.workers}</td>
                  <td className="right">{(h.cages / h.workers).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function KpiCard({
  icon, label, value, foot,
}: {
  icon: React.ReactNode
  label: string
  value: string
  foot?: string
}) {
  return (
    <div className="pr-kpi-card">
      <div className="pr-kpi-top">
        <div className="pr-kpi-icon">{icon}</div>
        <div className="pr-kpi-label">{label}</div>
      </div>
      <div className="pr-kpi-value">{value}</div>
      {foot && <div className="pr-kpi-foot">{foot}</div>}
    </div>
  )
}

function BarsIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 15v3" /><path d="M12 10v8" /><path d="M17 6v12" /></svg> }
function ClockIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg> }
function TrendIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 6 13.5 15.5l-5-5L1 18" /><path d="M17 6h6v6" /></svg> }
function PeopleIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg> }
