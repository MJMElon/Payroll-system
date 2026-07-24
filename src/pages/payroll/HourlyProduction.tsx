import { useState } from 'react'
import './SummaryReport.css'
import './HourlyProduction.css'

/**
 * Mock-data hourly production dashboard for FFB Reception. Visual merge
 * only — the monthly Hour x Date register, the Shift A / Shift B split, and
 * the "> 4 cages/hr" qualification tier are all generated deterministically
 * from a seeded pseudo-random function so the numbers stay internally
 * consistent (row/column totals, tier totals, and the KPI cards all derive
 * from the same grid) without a real hourly production_entries table yet.
 * Swapping in real per-hour queries later should only touch this file.
 *
 * Shift A is modeled as the day shift (0700-1900) and Shift B as the night
 * shift (1900-0700). A given hour only ever belongs to one shift's window.
 *
 * Qualification rule: an hour's cages only count toward the "> 4 cages/hr"
 * rate if the *previous* hour (same shift, same day) reached a minimum of
 * 4 cages. Never valid for a shift's first hour (shift change/start). Each
 * hour is classified as a whole into one tier or the other, matching how
 * the tracking sheet this is based on tallies its own tier rows.
 */

const HOUR_LABELS = [
  '0700 - 0800', '0800 - 0900', '0900 - 1000', '1000 - 1100', '1100 - 1200', '1200 - 1300',
  '1300 - 1400', '1400 - 1500', '1500 - 1600', '1600 - 1700', '1700 - 1800', '1800 - 1900',
  '1900 - 2000', '2000 - 2100', '2100 - 2200', '2200 - 2300', '2300 - 0000', '0000 - 0100',
  '0100 - 0200', '0200 - 0300', '0300 - 0400', '0400 - 0500', '0500 - 0600', '0600 - 0700',
]
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1)
const FIRST_DAY = 3
const LAST_DAY = 23 // recorded range this month so far

type ShiftKey = 'a' | 'b'
type ShiftFilter = 'all' | ShiftKey

interface RegisterCell {
  a: number | null
  b: number | null
  qualA: boolean
  qualB: boolean
}

function seededRand(seed: number) {
  const x = Math.sin(seed * 99991 + 12.9898) * 43758.5453
  return x - Math.floor(x)
}

function cagesFor(shift: ShiftKey, day: number, h: number): number | null {
  if (day < FIRST_DAY || day > LAST_DAY) return null
  const inA = h >= 0 && h <= 11
  const inB = h >= 12 && h <= 23
  if (shift === 'a' && !inA) return null
  if (shift === 'b' && !inB) return null
  const pos = shift === 'a' ? h : h - 12
  const seed = day * 1000 + h * 13 + (shift === 'a' ? 7 : 19)
  if (pos === 5) { // lunch (Shift A) / midnight meal break (Shift B)
    const r = seededRand(seed)
    return r < 0.25 ? 1 + Math.floor(seededRand(seed + 3) * 2) : null
  }
  const rampFactor = 1 - (Math.abs(pos - 5.5) / 5.5) * 0.45
  const r = seededRand(seed)
  const val = Math.round((2.5 + r * 6.5) * rampFactor)
  return Math.max(1, val)
}

function buildRegister() {
  const grid: RegisterCell[][] = []
  const rowTotal = { a: new Array(HOUR_LABELS.length).fill(0) as number[], b: new Array(HOUR_LABELS.length).fill(0) as number[] }
  const colTotal: { a: Record<number, number>; b: Record<number, number> } = { a: {}, b: {} }
  const colTier1: { a: Record<number, number>; b: Record<number, number> } = { a: {}, b: {} }
  const colTier2: { a: Record<number, number>; b: Record<number, number> } = { a: {}, b: {} }
  DAYS.forEach((d) => { colTotal.a[d] = 0; colTotal.b[d] = 0; colTier1.a[d] = 0; colTier1.b[d] = 0; colTier2.a[d] = 0; colTier2.b[d] = 0 })

  HOUR_LABELS.forEach((_, h) => {
    grid[h] = DAYS.map((d) => {
      const a = cagesFor('a', d, h)
      const b = cagesFor('b', d, h)
      if (a != null) { rowTotal.a[h] += a; colTotal.a[d] += a }
      if (b != null) { rowTotal.b[h] += b; colTotal.b[d] += b }
      return { a, b, qualA: false, qualB: false }
    })
  })

  DAYS.forEach((d, di) => {
    HOUR_LABELS.forEach((_, h) => {
      const cell = grid[h][di]
      if (cell.a != null) {
        const prevA = h > 0 ? grid[h - 1][di].a : null
        cell.qualA = h !== 0 && prevA != null && prevA >= 4
        if (cell.qualA) colTier2.a[d] += cell.a; else colTier1.a[d] += cell.a
      }
      if (cell.b != null) {
        const prevB = h > 12 ? grid[h - 1][di].b : null
        cell.qualB = h !== 12 && prevB != null && prevB >= 4
        if (cell.qualB) colTier2.b[d] += cell.b; else colTier1.b[d] += cell.b
      }
    })
  })

  const sumRecord = (r: Record<number, number>) => Object.values(r).reduce((s, v) => s + v, 0)
  const monthTotalA = sumRecord(colTotal.a), monthTotalB = sumRecord(colTotal.b)
  const monthTier1A = sumRecord(colTier1.a), monthTier2A = sumRecord(colTier2.a)
  const monthTier1B = sumRecord(colTier1.b), monthTier2B = sumRecord(colTier2.b)
  const recordedDays = LAST_DAY - FIRST_DAY + 1

  let peakH = 0, peakVal = -1
  HOUR_LABELS.forEach((_, h) => {
    const v = rowTotal.a[h] + rowTotal.b[h]
    if (v > peakVal) { peakVal = v; peakH = h }
  })

  return {
    grid, rowTotal, colTotal, colTier1, colTier2,
    monthTotalA, monthTotalB, monthTier1A, monthTier1B, monthTier2A, monthTier2B,
    recordedDays, peakH, peakVal,
  }
}

const REGISTER = buildRegister()

const num = (n: number) => n.toLocaleString('en-US')

function csvCell(v: string) {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function registerToCSV(): string {
  const header = ['Time', ...DAYS.flatMap((d) => [`${d} (Shift A)`, `${d} (Shift B)`]), 'Total (Shift A)', 'Total (Shift B)']
  const lines = [header]
  HOUR_LABELS.forEach((label, h) => {
    const row = [label]
    DAYS.forEach((_, di) => {
      const cell = REGISTER.grid[h][di]
      row.push(cell.a == null ? '' : String(cell.a))
      row.push(cell.b == null ? '' : String(cell.b))
    })
    row.push(String(REGISTER.rowTotal.a[h]), String(REGISTER.rowTotal.b[h]))
    lines.push(row)
  })
  const totalRow = ['Total']
  DAYS.forEach((d) => { totalRow.push(String(REGISTER.colTotal.a[d]), String(REGISTER.colTotal.b[d])) })
  totalRow.push(String(REGISTER.monthTotalA), String(REGISTER.monthTotalB))
  lines.push(totalRow)
  const tier1Row = ['1 - 4 cages /hr']
  DAYS.forEach((d) => { tier1Row.push(String(REGISTER.colTier1.a[d]), String(REGISTER.colTier1.b[d])) })
  tier1Row.push(String(REGISTER.monthTier1A), String(REGISTER.monthTier1B))
  lines.push(tier1Row)
  const tier2Row = ['> 4 cages /hr']
  DAYS.forEach((d) => { tier2Row.push(String(REGISTER.colTier2.a[d]), String(REGISTER.colTier2.b[d])) })
  tier2Row.push(String(REGISTER.monthTier2A), String(REGISTER.monthTier2B))
  lines.push(tier2Row)
  return lines.map((line) => line.map(csvCell).join(',')).join('\r\n')
}

function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function HourlyProduction() {
  const [shiftFilter, setShiftFilter] = useState<ShiftFilter>('all')

  const totalA = REGISTER.monthTotalA
  const totalB = REGISTER.monthTotalB
  const grandTotal = shiftFilter === 'all' ? totalA + totalB : shiftFilter === 'a' ? totalA : totalB

  function handleExportExcel() {
    downloadTextFile('FFB-Reception-Hourly-Register-July-2026.csv', registerToCSV(), 'text/csv;charset=utf-8;')
  }

  function handleExportPDF() {
    window.print()
  }

  return (
    <div className="pr-summary">
      <div className="pr-filters">
        <div className="pr-filter-field">
          <label>Month</label>
          <span className="pr-pill">July 2026</span>
        </div>
        <div className="pr-filter-field">
          <label>Shift</label>
          <select value={shiftFilter} onChange={(e) => setShiftFilter(e.target.value as ShiftFilter)}>
            <option value="all">All Shifts</option>
            <option value="a">Shift A</option>
            <option value="b">Shift B</option>
          </select>
        </div>
        <div className="pr-filter-field">
          <label>Station</label>
          <span className="pr-pill">FFB Reception</span>
        </div>
        <div className="pr-filters-spacer">
          <button className="pr-btn ghost" onClick={() => setShiftFilter('all')}>Reset</button>
          <button className="pr-btn export-xls" onClick={handleExportExcel}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></svg>
            Export Excel
          </button>
          <button className="pr-btn export-pdf" onClick={handleExportPDF}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></svg>
            Export PDF
          </button>
        </div>
      </div>

      <div className="pr-kpi-grid">
        <KpiCard icon={<BarsIcon />} label="Total Cages Tipped" value={num(grandTotal)} foot="July 2026 (to date) · FFB Reception" />
        <KpiCard icon={<MinusCircleIcon />} iconClass="blue" label="Shift A Cages" value={num(totalA)} foot={`${((totalA / (totalA + totalB)) * 100).toFixed(1)}% of month total`} />
        <KpiCard icon={<MinusCircleIcon />} iconClass="orange" label="Shift B Cages" value={num(totalB)} foot={`${((totalB / (totalA + totalB)) * 100).toFixed(1)}% of month total`} />
        <KpiCard icon={<ClockIcon />} iconClass="amber" label="Busiest Hour (avg)" value={HOUR_LABELS[REGISTER.peakH]} foot={`${(REGISTER.peakVal / REGISTER.recordedDays).toFixed(1)} cages/hr avg, combined`} />
      </div>

      <div className="pr-chart-card">
        <div className="pr-chart-head">
          <div>
            <div className="pr-chart-title">Average Cages Tipped by Hour</div>
            <div className="pr-chart-sub">Averaged across recorded days (1–23 Jul) · Shift A vs Shift B</div>
          </div>
          <div className="pr-legend">
            <div className="pr-legend-item"><span className="pr-legend-dot" style={{ background: 'var(--pr-series-blue)' }} />Shift A (day, 0700–1900)</div>
            <div className="pr-legend-item"><span className="pr-legend-dot" style={{ background: 'var(--pr-series-orange)' }} />Shift B (night, 1900–0700)</div>
          </div>
        </div>
        <AvgHourlyChart mode={shiftFilter} />
      </div>

      <div className="pr-reg-card">
        <div className="pr-reg-head">
          <h3>Monthly Hourly Register — July 2026</h3>
          <span className="muted small">FFB Reception · Time &amp; Total columns stay pinned while you scroll</span>
        </div>
        <div className="pr-reg-legend">
          <div className="pr-legend-item"><span className="pr-legend-dot" style={{ background: 'var(--pr-series-blue)' }} />Shift A cages that hour</div>
          <div className="pr-legend-item"><span className="pr-legend-dot" style={{ background: 'var(--pr-series-orange)' }} />Shift B cages that hour</div>
          <div className="pr-legend-item"><span className="pr-legend-dot qual" />Qualifies for &gt; 4 cages/hr (previous hour reached 4)</div>
        </div>
        <div className="pr-reg-scroll">
          <table className="pr-reg">
            <thead>
              <tr>
                <th className="time-col">Time</th>
                {DAYS.map((d) => <th key={d}>{d}</th>)}
                <th className="total-col">Total</th>
              </tr>
            </thead>
            <tbody>
              {HOUR_LABELS.map((label, h) => (
                <tr key={label}>
                  <td className="time-col">{label}</td>
                  {DAYS.map((d, di) => {
                    const cell = REGISTER.grid[h][di]
                    const qualified = (cell.a != null && cell.qualA) || (cell.b != null && cell.qualB)
                    return <RegCell key={d} a={cell.a} b={cell.b} mode={shiftFilter} qualified={qualified} className="day-col" />
                  })}
                  <RegSumCell a={REGISTER.rowTotal.a[h]} b={REGISTER.rowTotal.b[h]} mode={shiftFilter} className="total-col" hideZero />
                </tr>
              ))}
              <tr className="reg-summary">
                <td className="time-col">Total</td>
                {DAYS.map((d) => <RegSumCell key={d} a={REGISTER.colTotal.a[d]} b={REGISTER.colTotal.b[d]} mode={shiftFilter} className="day-col" />)}
                <RegSumCell a={REGISTER.monthTotalA} b={REGISTER.monthTotalB} mode={shiftFilter} className="total-col" />
              </tr>
              <tr className="reg-summary tier">
                <td className="time-col">1 – 4 cages /hr</td>
                {DAYS.map((d) => <RegSumCell key={d} a={REGISTER.colTier1.a[d]} b={REGISTER.colTier1.b[d]} mode={shiftFilter} className="day-col" />)}
                <RegSumCell a={REGISTER.monthTier1A} b={REGISTER.monthTier1B} mode={shiftFilter} className="total-col" />
              </tr>
              <tr className="reg-summary tier">
                <td className="time-col">&gt; 4 cages /hr</td>
                {DAYS.map((d) => <RegSumCell key={d} a={REGISTER.colTier2.a[d]} b={REGISTER.colTier2.b[d]} mode={shiftFilter} className="day-col" />)}
                <RegSumCell a={REGISTER.monthTier2A} b={REGISTER.monthTier2B} mode={shiftFilter} className="total-col" />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="pr-tier-grid">
        {shiftFilter !== 'b' && (
          <TierCard shift="a" label="Shift A — Cages by Tier (July, to date)" total1={REGISTER.monthTier1A} total2={REGISTER.monthTier2A} />
        )}
        {shiftFilter !== 'a' && (
          <TierCard shift="b" label="Shift B — Cages by Tier (July, to date)" total1={REGISTER.monthTier1B} total2={REGISTER.monthTier2B} />
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function RegCell({
  a, b, mode, qualified, className,
}: {
  a: number | null
  b: number | null
  mode: ShiftFilter
  qualified: boolean
  className: string
}) {
  const showA = mode !== 'b' ? a : null
  const showB = mode !== 'a' ? b : null
  if (showA == null && showB == null) {
    return <td className={className}><span className="pr-reg-empty">·</span></td>
  }
  return (
    <td className={qualified ? `${className} qualified` : className}>
      <div className="pr-reg-cell">
        {showA != null && <span className="pr-reg-a">{showA}</span>}
        {showB != null && <span className="pr-reg-b">{showB}</span>}
      </div>
    </td>
  )
}

function RegSumCell({
  a, b, mode, className, hideZero,
}: {
  a: number
  b: number
  mode: ShiftFilter
  className: string
  hideZero?: boolean
}) {
  let va: number | null = mode !== 'b' ? a : null
  let vb: number | null = mode !== 'a' ? b : null
  if (hideZero) {
    if (va === 0) va = null
    if (vb === 0) vb = null
  }
  if (va == null && vb == null) {
    return <td className={className}><span className="pr-reg-empty">·</span></td>
  }
  return (
    <td className={className}>
      <div className="pr-reg-cell">
        {va != null && <span className="pr-reg-a">{va}</span>}
        {vb != null && <span className="pr-reg-b">{vb}</span>}
      </div>
    </td>
  )
}

function AvgHourlyChart({ mode }: { mode: ShiftFilter }) {
  const maxAvg = Math.max(...HOUR_LABELS.map((_, h) => {
    const a = mode !== 'b' ? REGISTER.rowTotal.a[h] / REGISTER.recordedDays : 0
    const b = mode !== 'a' ? REGISTER.rowTotal.b[h] / REGISTER.recordedDays : 0
    return mode === 'all' ? a + b : Math.max(a, b)
  }))

  return (
    <div className="pr-hourly-chart-scroll">
      <div className="pr-hourly-chart">
        {HOUR_LABELS.map((label, h) => {
          const avgA = REGISTER.rowTotal.a[h] / REGISTER.recordedDays
          const avgB = REGISTER.rowTotal.b[h] / REGISTER.recordedDays
          const isBreak = h === 5 || h === 17
          const showA = mode !== 'b' && avgA > 0
          const showB = mode !== 'a' && avgB > 0
          return (
            <div className="pr-hourly-col" key={label}>
              <div className={`pr-hourly-bars${isBreak ? ' brk' : ''}`}>
                {showA && (
                  <div className="pr-hourly-track">
                    <div className="pr-hourly-bar a" style={{ height: `${(avgA / maxAvg) * 100}%` }}>
                      <span className="pr-hourly-bar-val">{avgA.toFixed(1)}</span>
                    </div>
                  </div>
                )}
                {showB && (
                  <div className="pr-hourly-track">
                    <div className="pr-hourly-bar b" style={{ height: `${(avgB / maxAvg) * 100}%` }}>
                      <span className="pr-hourly-bar-val">{avgB.toFixed(1)}</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="pr-hourly-label">{label.slice(0, 2)}–{label.slice(7, 9)}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TierCard({
  shift, label, total1, total2,
}: {
  shift: ShiftKey
  label: string
  total1: number
  total2: number
}) {
  const total = total1 + total2
  const pct1 = (total1 / total) * 100
  const pct2 = 100 - pct1
  return (
    <div className={`pr-tier-card ${shift}`}>
      <div className="pr-tier-head">
        <span className="pr-tier-dot" />
        <h3>{label}</h3>
        <span className="total">{num(total)}</span>
      </div>
      <div className="pr-tier-bar">
        <div className="seg1" style={{ width: `${pct1}%` }} />
        <div className="seg2" style={{ width: `${pct2}%` }} />
      </div>
      <div className="pr-tier-rows">
        <div className="pr-tier-row"><span className="sw d1" />1–4 cages/hr<span className="amt">{num(total1)}</span><span className="pct">{pct1.toFixed(1)}%</span></div>
        <div className="pr-tier-row"><span className="sw d2" />&gt; 4 cages/hr<span className="amt">{num(total2)}</span><span className="pct">{pct2.toFixed(1)}%</span></div>
      </div>
    </div>
  )
}

function KpiCard({
  icon, iconClass, label, value, foot,
}: {
  icon: React.ReactNode
  iconClass?: string
  label: string
  value: string
  foot?: string
}) {
  return (
    <div className="pr-kpi-card">
      <div className="pr-kpi-top">
        <div className={`pr-kpi-icon${iconClass ? ` ${iconClass}` : ''}`}>{icon}</div>
        <div className="pr-kpi-label">{label}</div>
      </div>
      <div className="pr-kpi-value">{value}</div>
      {foot && <div className="pr-kpi-foot">{foot}</div>}
    </div>
  )
}

function BarsIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 15v3" /><path d="M12 10v8" /><path d="M17 6v12" /></svg> }
function ClockIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg> }
function MinusCircleIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8.5 12h7" /></svg> }
