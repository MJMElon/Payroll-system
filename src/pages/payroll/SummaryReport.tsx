import { useState } from 'react'
import './SummaryReport.css'

/**
 * Mock-data summary dashboard for FFB Reception. Visual merge only — every
 * number below is placeholder data shaped like the real Supabase fields
 * (workers, payroll_lines) plus a few not-yet-modeled ones (nationality,
 * shift, cage tiers, verification status) that still need schema work.
 * Swapping in real queries later should only touch this file.
 */

type Status = 'pending' | 'verified' | 'approved'

interface WorkerRow {
  name: string
  id: string
  role: string
  shift: 'A' | 'B'
  days: number
  c14: number | null
  c4p: number | null
  piece: number
  leave: number
  ot: number
  allow: number
  ded: number
  status: Status
}

const ROWS: WorkerRow[] = [
  { name: 'Mohd Hafiz Bin Ali', id: 'W-0123', role: 'FFB Inspector', shift: 'A', days: 26, c14: 180, c4p: 396, piece: 8432.60, leave: 0, ot: 1820, allow: 180, ded: 910, status: 'approved' },
  { name: 'Siti Aisyah Bt. Ramli', id: 'W-0187', role: 'Ramp Operator', shift: 'B', days: 26, c14: 140, c4p: 308, piece: 6752.00, leave: 0, ot: 1820, allow: 150, ded: 720, status: 'verified' },
  { name: 'Rajesh A/L Kumar', id: 'W-0076', role: 'Weighbridge Operator', shift: 'A', days: 25, c14: 160, c4p: 353, piece: 7868.50, leave: 0, ot: 1750, allow: 150, ded: 840, status: 'pending' },
  { name: 'Sutrisno', id: 'W-0211', role: 'Kernel Recovery', shift: 'B', days: 26, c14: 110, c4p: 231, piece: 5220.80, leave: 420, ot: 1820, allow: 120, ded: 620, status: 'pending' },
  { name: 'Kamalul Azlan Bin Hamid', id: 'W-0098', role: 'Oil Recovery', shift: 'A', days: 24, c14: 100, c4p: 213, piece: 4860.00, leave: 420, ot: 1680, allow: 120, ded: 560, status: 'pending' },
  { name: 'Budi Santoso', id: 'W-0302', role: 'Press & Threshing', shift: 'B', days: 26, c14: 90, c4p: 197, piece: 4580.80, leave: 0, ot: 1820, allow: 100, ded: 720, status: 'verified' },
  { name: 'Muhammad Iqram Bin Zainal', id: 'W-0148', role: 'Lab Technician', shift: 'A', days: 25, c14: null, c4p: null, piece: 0, leave: 2000, ot: 1750, allow: 150, ded: 400, status: 'verified' },
  { name: 'Lim Wei Sheng', id: 'W-0264', role: 'EB Station', shift: 'B', days: 23, c14: null, c4p: null, piece: 0, leave: 1840, ot: 1610, allow: 100, ded: 380, status: 'pending' },
  { name: 'Rosi Bin Ahmad', id: 'W-0331', role: 'Water Treatment Plant', shift: 'A', days: 26, c14: null, c4p: null, piece: 0, leave: 1820, ot: 1620, allow: 90, ded: 350, status: 'approved' },
  { name: 'Faridah Bt. Yusof', id: 'W-0410', role: 'FFB Reception', shift: 'B', days: 26, c14: 155, c4p: 344, piece: 7462.50, leave: 0, ot: 1820, allow: 150, ded: 850, status: 'approved' },
  { name: 'Nur Aisyah Bt. Ismail', id: 'W-0455', role: 'Weighbridge Clerk', shift: 'A', days: 25, c14: 125, c4p: 277, piece: 6030.00, leave: 0, ot: 1750, allow: 140, ded: 480, status: 'verified' },
  { name: 'Amirul Hakim Bin Zulkifli', id: 'W-0512', role: 'Ramp Operator', shift: 'B', days: 26, c14: 140, c4p: 315, piece: 6825.00, leave: 0, ot: 1820, allow: 150, ded: 730, status: 'approved' },
]

const STATUS_LABEL: Record<Status, string> = {
  pending: 'Pending Verification',
  verified: 'Verified',
  approved: 'Approved',
}

const YTD_MONTHS = ['Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026']
const YTD_FACTORS = [0.78, 0.83, 0.88, 0.90, 0.94, 0.97, 1.00]

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const initialsOf = (name: string) =>
  name.split(' ').filter((w) => /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]).join('')
const grossOf = (r: WorkerRow) => r.piece + r.leave + r.ot + r.allow
const netOf = (r: WorkerRow) => grossOf(r) - r.ded

export default function SummaryReport() {
  const [shiftFilter, setShiftFilter] = useState<'all' | 'A' | 'B'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | Status>('all')
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)

  if (selectedIdx != null) {
    return <WorkerDetail row={ROWS[selectedIdx]} onBack={() => setSelectedIdx(null)} />
  }

  const totalWorkers = ROWS.length
  const indonesian = 2
  const malaysian = totalWorkers - indonesian

  const totalC14 = sum(ROWS, (r) => r.c14 ?? 0)
  const totalC4p = sum(ROWS, (r) => r.c4p ?? 0)
  const totalCages = totalC14 + totalC4p

  const piece = sum(ROWS, (r) => r.piece)
  const leave = sum(ROWS, (r) => r.leave)
  const ot = sum(ROWS, (r) => r.ot)
  const allow = sum(ROWS, (r) => r.allow)
  const ded = sum(ROWS, (r) => r.ded)
  const gross = piece + leave + ot + allow
  const net = gross - ded
  const pctOfGross = (v: number) => (gross ? (v / gross) * 100 : 0)

  const shiftACages = sum(ROWS.filter((r) => r.shift === 'A'), (r) => (r.c14 ?? 0) + (r.c4p ?? 0))
  const shiftBCages = sum(ROWS.filter((r) => r.shift === 'B'), (r) => (r.c14 ?? 0) + (r.c4p ?? 0))

  const dayVals = [2.7, 3.1, 2.9, 3.8, 4.1, 3.9, 2.9, 2.5, 2.4, 3.0, 3.7, 4.1, 4.4, 4.2, 3.3, 2.8, 2.4, 2.7, 3.4, 4.0, 4.4, 4.2, 3.5, 2.9, 2.6, 2.5, 3.0, 3.6, 4.1, 4.5, 3.8]

  const filteredRows = ROWS.filter(
    (r) => (shiftFilter === 'all' || r.shift === shiftFilter) && (statusFilter === 'all' || r.status === statusFilter),
  )
  const filteredGross = sum(filteredRows, grossOf)
  const filteredNet = sum(filteredRows, netOf)
  const filterSuffix = [
    shiftFilter !== 'all' ? `Shift ${shiftFilter}` : null,
    statusFilter !== 'all' ? STATUS_LABEL[statusFilter] : null,
  ].filter(Boolean).join(', ')

  function handleReset() {
    setShiftFilter('all')
    setStatusFilter('all')
  }

  function handleExportExcel() {
    const suffix = filterSuffix ? `-${filterSuffix.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''
    downloadTextFile(
      `FFB-Reception-Payroll-Summary-July-2026${suffix}.csv`,
      rowsToCSV(filteredRows),
      'text/csv;charset=utf-8;',
    )
  }

  function handleExportPDF() {
    window.print()
  }

  return (
    <div className="pr-summary">
      <div className="pr-filters">
        <div className="pr-filter-field">
          <label>Payroll Month</label>
          <span className="pr-pill">July 2026</span>
        </div>
        <div className="pr-filter-field">
          <label>Shift</label>
          <select value={shiftFilter} onChange={(e) => setShiftFilter(e.target.value as 'all' | 'A' | 'B')}>
            <option value="all">All</option>
            <option value="A">Shift A</option>
            <option value="B">Shift B</option>
          </select>
        </div>
        <div className="pr-filter-field">
          <label>Position</label>
          <span className="pr-pill">All Positions</span>
        </div>
        <div className="pr-filter-field">
          <label>Worker Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | Status)}>
            <option value="all">All Status</option>
            <option value="pending">Pending Verification</option>
            <option value="verified">Verified</option>
            <option value="approved">Approved</option>
          </select>
        </div>
        <div className="pr-filters-spacer">
          <button className="pr-btn ghost" onClick={handleReset}>Reset</button>
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
        <KpiCard icon={<PeopleIcon />} label="Total Workers" value={String(totalWorkers)}>
          <SplitBar items={[
            { label: 'Indonesian', amt: indonesian, color: 'var(--pr-series-blue)' },
            { label: 'Malaysian', amt: malaysian, color: 'var(--pr-series-orange)' },
          ]} />
        </KpiCard>

        <KpiCard icon={<BoxIcon />} label="Total Cages" value={num(totalCages)} foot="cages tipped this period">
          <SplitBar items={[
            { label: '1–4 cages', amt: totalC14, color: 'var(--pr-series-blue)' },
            { label: '>4 cages', amt: totalC4p, color: 'var(--pr-series-orange)' },
          ]} />
        </KpiCard>

        <KpiCard icon={<DollarIcon />} label="Piece-Rate Pay" value={`RM ${fmt(piece)}`} foot={`${pctOfGross(piece).toFixed(1)}% of gross payroll`} />
        <KpiCard icon={<WalletIcon />} label="Daily Wages" value={`RM ${fmt(leave)}`} foot={`${pctOfGross(leave).toFixed(1)}% of gross payroll`} />
        <KpiCard icon={<ClockIcon />} label="Incentive / Allowance" value={`RM ${fmt(ot)}`} foot={`${pctOfGross(ot).toFixed(1)}% of gross payroll`} />
        <KpiCard icon={<PlusIcon />} label="Others" value={`RM ${fmt(allow)}`} foot={`${pctOfGross(allow).toFixed(1)}% of gross payroll`} />
        <KpiCard icon={<ReceiptIcon />} label="Deductions" value={`RM ${fmt(ded)}`} foot={`${pctOfGross(ded).toFixed(1)}% of gross payroll`} />
        <KpiCard icon={<BanknoteIcon />} label="Net Payroll" value={`RM ${fmt(net)}`} foot={`${pctOfGross(net).toFixed(1)}% of gross payroll`} footGood />
      </div>

      <div className="pr-charts-grid">
        <div className="pr-chart-card">
          <div className="pr-chart-title">Daily Payroll Trend (RM)</div>
          <TrendChart dayVals={dayVals} />
        </div>
        <div className="pr-chart-card">
          <div className="pr-chart-title">Cages Tipped — Shift A vs Shift B</div>
          <Donut
            segments={[
              { name: 'Shift A', pct: (shiftACages / totalCages) * 100, valueLabel: `${num(shiftACages)} cages`, color: 'var(--pr-series-blue)' },
              { name: 'Shift B', pct: (shiftBCages / totalCages) * 100, valueLabel: `${num(shiftBCages)} cages`, color: 'var(--pr-series-orange)' },
            ]}
          />
          <div className="pr-chart-total-row"><span>Total</span><b>{num(totalCages)} cages</b></div>
        </div>
      </div>

      <div className="pr-table-card">
        <div className="pr-table-card-head">
          <h3>Worker Payroll Summary</h3>
          <span className="muted small">All amounts in RM</span>
        </div>
        <div className="pr-table-scroll">
          <table className="pr-data">
            <colgroup>
              <col style={{ width: 30 }} /><col style={{ width: 130 }} /><col style={{ width: 60 }} />
              <col style={{ width: 98 }} /><col style={{ width: 40 }} /><col style={{ width: 40 }} />
              <col style={{ width: 56 }} /><col style={{ width: 56 }} /><col style={{ width: 76 }} />
              <col style={{ width: 66 }} /><col style={{ width: 70 }} /><col style={{ width: 76 }} />
              <col style={{ width: 70 }} /><col style={{ width: 76 }} /><col style={{ width: 76 }} />
              <col style={{ width: 101 }} />
            </colgroup>
            <thead>
              <tr>
                <th>#</th><th>Worker</th><th>ID</th><th>Position</th><th>Shift</th>
                <th className="right">Days</th><th className="right">1-4 Cages</th><th className="right">&gt; 4 Cages</th>
                <th className="right">Piece-Rate</th><th className="right">Wages</th>
                <th className="right">OT</th><th className="right">Allowance</th>
                <th className="right">Deduction</th><th className="right">Gross Pay</th>
                <th className="right">Net Pay</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r, i) => {
                const originalIdx = ROWS.indexOf(r)
                const g = grossOf(r), n = netOf(r)
                return (
                  <tr key={r.id}>
                    <td className="muted">{i + 1}</td>
                    <td className="wrap">
                      <button className="pr-worker-link" onClick={() => setSelectedIdx(originalIdx)}>{r.name}</button>
                    </td>
                    <td className="muted">{r.id}</td>
                    <td className="wrap">{r.role}</td>
                    <td>{r.shift}</td>
                    <td className="right">{r.days}</td>
                    <td className="right">{r.c14 == null ? '—' : num(r.c14)}</td>
                    <td className="right">{r.c4p == null ? '—' : num(r.c4p)}</td>
                    <td className="right">{fmt(r.piece)}</td>
                    <td className="right">{fmt(r.leave)}</td>
                    <td className="right">{fmt(r.ot)}</td>
                    <td className="right">{fmt(r.allow)}</td>
                    <td className="right">{fmt(r.ded)}</td>
                    <td className="right">{fmt(g)}</td>
                    <td className="right"><strong>{fmt(n)}</strong></td>
                    <td className="wrap"><span className={`pr-status-pill ${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
                  </tr>
                )
              })}
              <tr className="pr-total-row">
                <td colSpan={13}>Total{filterSuffix ? ` — ${filterSuffix}` : ''}</td>
                <td className="right">{fmt(filteredGross)}</td>
                <td className="right">{fmt(filteredNet)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <div className="pr-table-foot">
          <span>
            {filterSuffix
              ? `Showing ${filteredRows.length} ${filterSuffix} workers at FFB Reception`
              : `Showing all ${ROWS.length} workers at FFB Reception`}
          </span>
          <span className="muted small pr-hint">Click a worker's name to open their payroll detail</span>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function WorkerDetail({ row, onBack }: { row: WorkerRow; onBack: () => void }) {
  const gross = grossOf(row)
  const net = netOf(row)
  const seed = ROWS.indexOf(row) + 1
  const history = YTD_FACTORS.map((f, i) => net * f * (0.95 + 0.03 * ((seed + i) % 3)))
  const maxHist = Math.max(...history, 1)

  return (
    <div className="pr-summary">
      <button className="pr-back-link" onClick={onBack}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
        Back to FFB Reception Summary
      </button>

      <div className="pr-detail-head">
        <div className="pr-detail-avatar">{initialsOf(row.name)}</div>
        <div>
          <h1>{row.name}</h1>
          <div className="pr-meta">{row.role} · Shift {row.shift} · FFB Reception</div>
        </div>
        <span className={`pr-status-pill ${row.status}`} style={{ marginLeft: 'auto' }}>{STATUS_LABEL[row.status]}</span>
      </div>

      <div className="pr-kpi-card">
        <div className="pr-stat-row">
          <div className="pr-stat-block"><div className="pr-label">1-4 Cages</div><div className="pr-value">{row.c14 == null ? '—' : num(row.c14)}</div></div>
          <div className="pr-stat-block"><div className="pr-label">&gt; 4 Cages</div><div className="pr-value">{row.c4p == null ? '—' : num(row.c4p)}</div></div>
          <div className="pr-stat-block"><div className="pr-label">Days Worked</div><div className="pr-value">{row.days}</div></div>
          <div className="pr-stat-block"><div className="pr-label">Gross Pay</div><div className="pr-value">RM {fmt(gross)}</div></div>
          <div className="pr-stat-block"><div className="pr-label">Net Pay</div><div className="pr-value">RM {fmt(net)}</div></div>
        </div>
      </div>

      <div className="pr-table-card">
        <div className="pr-table-card-head"><h3>Pay Breakdown — July 2026</h3></div>
        <div className="pr-table-scroll">
          <table className="pr-data">
            <thead><tr><th>Component</th><th className="right">Amount (RM)</th></tr></thead>
            <tbody>
              <tr><td>Piece-Rate Pay</td><td className="right">{fmt(row.piece)}</td></tr>
              <tr><td>Wages</td><td className="right">{fmt(row.leave)}</td></tr>
              <tr><td>OT</td><td className="right">{fmt(row.ot)}</td></tr>
              <tr><td>Allowance</td><td className="right">{fmt(row.allow)}</td></tr>
              <tr><td className="muted">Deduction</td><td className="right">−{fmt(row.ded)}</td></tr>
              <tr className="pr-total-row"><td>Net Pay</td><td className="right">{fmt(net)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="pr-table-card" style={{ padding: '1rem 1.1rem' }}>
        <h3 style={{ margin: '0 0 0.15rem' }}>Net Pay History — 2026</h3>
        <p className="muted small" style={{ margin: '0 0 0.6rem' }}>Year to date, January through the current period</p>
        {history.map((v, i) => (
          <div className={`pr-history-row${i === history.length - 1 ? ' current' : ''}`} key={YTD_MONTHS[i]}>
            <span className="pr-hist-label">{YTD_MONTHS[i]}{i === history.length - 1 ? ' (current)' : ''}</span>
            <span className="pr-hist-track"><span className="pr-hist-bar" style={{ width: `${(v / maxHist) * 100}%` }} /></span>
            <span className="pr-hist-val">RM {fmt(v)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function KpiCard({
  icon, label, value, foot, footGood, children,
}: {
  icon: React.ReactNode
  label: string
  value: string
  foot?: string
  footGood?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="pr-kpi-card">
      <div className="pr-kpi-top">
        <div className="pr-kpi-icon">{icon}</div>
        <div className="pr-kpi-label">{label}</div>
      </div>
      <div className="pr-kpi-value">{value}</div>
      {foot && <div className={`pr-kpi-foot${footGood ? ' good' : ''}`}>{foot}</div>}
      {children}
    </div>
  )
}

function SplitBar({ items }: { items: { label: string; amt: number; color: string }[] }) {
  const total = items.reduce((s, i) => s + i.amt, 0) || 1
  return (
    <>
      <div className="pr-split-bar">
        {items.map((i) => (
          <div key={i.label} style={{ width: `${(i.amt / total) * 100}%`, background: i.color }} />
        ))}
      </div>
      <div className="pr-split-legend">
        {items.map((i) => (
          <div className="pr-split-row" key={i.label}>
            <span className="pr-dot" style={{ background: i.color }} />
            {i.label}
            <span className="pr-amt">{num(i.amt)}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function Donut({ segments }: { segments: { name: string; pct: number; valueLabel: string; color: string }[] }) {
  const r = 40, cx = 50, cy = 50, circumf = 2 * Math.PI * r, gap = 1.6
  let offset = 0
  return (
    <div className="pr-donut-body">
      <svg width={104} height={104} viewBox="0 0 100 100">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--pr-grid-line)" strokeWidth={12} />
        {segments.map((seg) => {
          const len = Math.max((seg.pct / 100) * circumf - gap, 0)
          const el = (
            <circle
              key={seg.name}
              cx={cx} cy={cy} r={r} fill="none" stroke={seg.color} strokeWidth={12}
              strokeDasharray={`${len} ${circumf}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          )
          offset += (seg.pct / 100) * circumf
          return el
        })}
        <text x={cx} y={cy + 3} textAnchor="middle" fontSize={9} fontWeight={800} fill="var(--text)">100%</text>
      </svg>
      <div className="pr-donut-legend">
        {segments.map((seg) => (
          <div className="pr-dl-row" key={seg.name}>
            <span className="pr-dot" style={{ background: seg.color }} />
            <span className="pr-name">{seg.name}</span>
            <span className="pr-pct">{seg.pct.toFixed(1)}%</span>
            <span className="pr-val">{seg.valueLabel}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TrendChart({ dayVals }: { dayVals: number[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const padL = 42, padR = 10, padT = 12, padB = 24, W = 620, H = 210
  const plotW = W - padL - padR, plotH = H - padT - padB, yMax = 5
  const xAt = (i: number) => padL + (i / (dayVals.length - 1)) * plotW
  const yAt = (v: number) => padT + plotH - (v / yMax) * plotH

  const linePath = dayVals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(v)}`).join(' ')
  const areaPath = `${linePath} L ${xAt(dayVals.length - 1)} ${yAt(0)} L ${xAt(0)} ${yAt(0)} Z`

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (W / rect.width)
    let idx = Math.round(((mx - padL) / plotW) * (dayVals.length - 1))
    idx = Math.max(0, Math.min(dayVals.length - 1, idx))
    setHover(idx)
  }

  return (
    <div className="pr-line-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        <defs>
          <linearGradient id="prLineGrad" x1={0} y1={0} x2={0} y2={1}>
            <stop offset="0%" stopColor="var(--pr-series-blue)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--pr-series-blue)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4, 5].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={yAt(v)} y2={yAt(v)} stroke="var(--pr-grid-line)" strokeWidth={1} />
            <text x={padL - 8} y={yAt(v) + 3} fill="var(--pr-muted)" fontSize={9} textAnchor="end">{v}K</text>
          </g>
        ))}
        {dayVals.map((_, i) => (i % 5 === 0 || i === dayVals.length - 1) && (
          <text key={i} x={xAt(i)} y={206} fill="var(--pr-muted)" fontSize={9} textAnchor="middle">{i + 1} Jul</text>
        ))}
        <path d={areaPath} fill="url(#prLineGrad)" stroke="none" />
        <path d={linePath} fill="none" stroke="var(--pr-series-blue)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
        {hover != null && (
          <g>
            <line x1={xAt(hover)} x2={xAt(hover)} y1={padT} y2={padT + plotH} stroke="var(--pr-muted)" strokeWidth={1} strokeDasharray="3,3" />
            <circle cx={xAt(hover)} cy={yAt(dayVals[hover])} r={4} fill="var(--pr-series-blue)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
        <rect x={padL} y={padT} width={plotW} height={plotH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hover != null && (
        <div
          className="pr-line-tooltip"
          style={{ left: `${(xAt(hover) / W) * 100}%`, top: `${(yAt(dayVals[hover]) / H) * 100}%`, opacity: 1 }}
        >
          {hover + 1} Jul — RM {Math.round(dayVals[hover] * 1000).toLocaleString('en-US')}
        </div>
      )}
    </div>
  )
}

function sum<T>(arr: T[], fn: (item: T) => number) { return arr.reduce((s, item) => s + fn(item), 0) }
function num(n: number) { return n.toLocaleString('en-US') }

function csvCell(v: string) {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function rowsToCSV(rows: WorkerRow[]): string {
  const header = [
    '#', 'Worker', 'ID', 'Position', 'Shift', 'Days', '1-4 Cages', '> 4 Cages',
    'Piece-Rate (RM)', 'Wages (RM)', 'OT (RM)', 'Allowance (RM)', 'Deduction (RM)',
    'Gross Pay (RM)', 'Net Pay (RM)', 'Status',
  ]
  const lines = [header]
  rows.forEach((r, i) => {
    lines.push([
      String(i + 1), r.name, r.id, r.role, r.shift, String(r.days),
      r.c14 == null ? '' : String(r.c14), r.c4p == null ? '' : String(r.c4p),
      r.piece.toFixed(2), r.leave.toFixed(2), r.ot.toFixed(2), r.allow.toFixed(2), r.ded.toFixed(2),
      grossOf(r).toFixed(2), netOf(r).toFixed(2), STATUS_LABEL[r.status],
    ])
  })
  lines.push([
    '', 'Total', '', '', '', '', '', '', '', '', '', '', '',
    sum(rows, grossOf).toFixed(2), sum(rows, netOf).toFixed(2), '',
  ])
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

function PeopleIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg> }
function BoxIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8 12 3 3 8l9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg> }
function DollarIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v10" /><path d="M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1-3 2.3c0 3 6 1.5 6 4.4 0 1.4-1.3 2.3-3 2.3s-3-1-3-2.3" /></svg> }
function WalletIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="13" rx="2" /><path d="M16 7V5a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v2" /><path d="M2 11h20" /></svg> }
function ClockIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg> }
function PlusIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8.5 12h7" /><path d="M12 8.5v7" /></svg> }
function ReceiptIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M9 15h6" /></svg> }
function BanknoteIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="3" /><path d="M6 12h.01M18 12h.01" /></svg> }
