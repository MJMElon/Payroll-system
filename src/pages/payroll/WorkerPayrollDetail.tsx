import { useMemo, useState } from 'react'
import type { WorkerRow, Status } from './SummaryReport'
import { STATUS_LABEL } from './SummaryReport'
import './SummaryReport.css'
import './WorkerPayrollDetail.css'

/**
 * Individual worker payroll detail — visual merge only. Cage Records,
 * Attendance & Leave, Incentive/Allowance, and Others & Deduction line
 * items are all generated deterministically from the worker's monthly
 * totals in SummaryReport.tsx, since none of that per-record data exists
 * in Supabase yet. Editing here is a client-side demo only; nothing
 * persists. Swapping in real per-record queries later should only touch
 * this file.
 */

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num = (n: number) => n.toLocaleString('en-US')
const initialsOf = (name: string) =>
  name.split(' ').filter((w) => /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]).join('')
const totalWagesOf = (r: WorkerRow) => r.wages + r.ot
const grossOf = (r: WorkerRow) => totalWagesOf(r) + r.piece + r.incentive + r.others
const netOf = (r: WorkerRow) => grossOf(r) - r.ded

const YTD_MONTHS = ['Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026']
const YTD_FACTORS = [0.78, 0.83, 0.88, 0.90, 0.94, 0.97, 1.00]

type CageStatus = 'verified' | 'pending'

interface CageRecord {
  no: number
  date: string // DD/MM/YYYY
  time: string
  total: number
  c14: number
  c4p: number
  amt: number
  status: CageStatus
}

/** One record per day worked, allocated so totals match the worker's real monthly c14/c4p/piece. */
function genCageRecords(row: WorkerRow): CageRecord[] {
  if (row.c14 == null || row.c4p == null || row.days === 0) return []
  const n = row.days
  const weight = row.c14 + row.c4p * 1.5
  const rateA = weight > 0 ? row.piece / weight : 0
  const rateB = rateA * 1.5
  const baseC14 = Math.floor(row.c14 / n)
  const baseC4p = Math.floor(row.c4p / n)
  const remC14 = row.c14 - baseC14 * n
  const remC4p = row.c4p - baseC4p * n
  const time = row.shift === 'A' ? '07:00–15:00' : '15:00–23:00'
  const records: CageRecord[] = []
  for (let i = 0; i < n; i++) {
    const c14i = baseC14 + (i < remC14 ? 1 : 0)
    const c4pi = baseC4p + (i < remC4p ? 1 : 0)
    const amt = Math.round((c14i * rateA + c4pi * rateB) * 100) / 100
    const day = String(i + 1).padStart(2, '0')
    records.push({
      no: i + 1,
      date: `${day}/07/2026`,
      time,
      total: c14i + c4pi,
      c14: c14i,
      c4p: c4pi,
      amt,
      status: row.status === 'pending' && i === n - 1 ? 'pending' : 'verified',
    })
  }
  return records
}

interface AttendanceRecord {
  date: string
  clockIn: string
  clockOut: string
  hours: number
  status: 'present' | 'late' | 'leave'
  remarks: string
}

function genAttendance(row: WorkerRow): AttendanceRecord[] {
  const n = Math.min(row.days, 5)
  const records: AttendanceRecord[] = []
  for (let i = 0; i < n; i++) {
    const day = String(i + 1).padStart(2, '0')
    const late = i === 1
    records.push({
      date: `${day}/07/2026`,
      clockIn: late ? '07:12' : '06:58',
      clockOut: '15:04',
      hours: late ? 7.8 : 8.1,
      status: late ? 'late' : 'present',
      remarks: late ? 'Traffic delay' : '',
    })
  }
  // Paid leave days are separate calendar days beyond the worked sample above —
  // still a full paid day (8 hours), just no clock-in/out.
  for (let i = 0; i < row.leaveDays; i++) {
    const day = String(n + i + 1).padStart(2, '0')
    records.push({
      date: `${day}/07/2026`,
      clockIn: '—',
      clockOut: '—',
      hours: 8,
      status: 'leave',
      remarks: 'Annual Leave (Paid)',
    })
  }
  return records
}

function parseDMY(s: string) {
  const [d, m, y] = s.split('/').map(Number)
  return new Date(y, m - 1, d)
}
function parseYMD(s: string): Date | null {
  if (!s) return null
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export default function WorkerPayrollDetail({ row, onBack }: { row: WorkerRow; onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<'cage' | 'attendance' | 'incentive' | 'deduction'>('cage')

  const [cageRecords, setCageRecords] = useState<CageRecord[]>(() => genCageRecords(row))
  const [cageEditingNo, setCageEditingNo] = useState<number | null>(null)
  const [dateFrom, setDateFrom] = useState('2026-07-01')
  const [dateTo, setDateTo] = useState('2026-07-26')
  const [cageStatusFilter, setCageStatusFilter] = useState<'all' | CageStatus>('all')
  const [appliedFilter, setAppliedFilter] = useState({ from: '2026-07-01', to: '2026-07-26', status: 'all' as 'all' | CageStatus })

  const attendance = useMemo(() => genAttendance(row), [row])

  const [incentiveRows, setIncentiveRows] = useState(() => [
    { key: 'allowance', label: 'Allowance', amt: row.incentive },
    { key: 'incentive', label: 'Incentive', amt: row.others },
  ])
  const [incentiveEditing, setIncentiveEditing] = useState<string | null>(null)

  const penalty = Math.min(15, Math.round(row.ded * 0.02))
  const [deductionRows, setDeductionRows] = useState(() => [
    { key: 'penalty', label: 'Penalty', type: 'Penalty', amt: penalty },
    { key: 'other', label: 'Other Deduction', type: 'Other Deduction', amt: row.ded - penalty },
  ])
  const [deductionEditing, setDeductionEditing] = useState<string | null>(null)

  const gross = grossOf(row)
  const net = netOf(row)
  const seed = row.id.length + row.id.charCodeAt(row.id.length - 1)
  const history = YTD_FACTORS.map((f, i) => net * f * (0.95 + 0.03 * ((seed + i) % 3)))

  const payrollStatus: Status = cageRecords.some((r) => r.status === 'pending')
    ? 'pending'
    : row.status === 'approved' ? 'approved' : 'verified'

  const otRate = row.days ? Math.round((row.ot / row.days / 8) * 100) / 100 : 14
  const totalPayableDays = row.days + row.leaveDays

  const filteredCage = useMemo(() => {
    const fromD = parseYMD(appliedFilter.from)
    const toD = parseYMD(appliedFilter.to)
    return cageRecords.filter((r) => {
      const d = parseDMY(r.date)
      if (fromD && d < fromD) return false
      if (toD && d > toD) return false
      if (appliedFilter.status !== 'all' && r.status !== appliedFilter.status) return false
      return true
    })
  }, [cageRecords, appliedFilter])

  function handleSearch() {
    setAppliedFilter({ from: dateFrom, to: dateTo, status: cageStatusFilter })
  }

  function saveCageRow(no: number, patch: Partial<CageRecord>) {
    setCageRecords((rows) => rows.map((r) => (r.no === no ? { ...r, ...patch } : r)))
    setCageEditingNo(null)
  }

  const totalCages = cageRecords.reduce((s, r) => s + r.total, 0)
  const total1to4 = cageRecords.reduce((s, r) => s + r.c14, 0)
  const totalOver4 = cageRecords.reduce((s, r) => s + r.c4p, 0)

  return (
    <div className="pr-summary">
      <div className="pr-wd-card">
        <div className="pr-wd-banner">
          <h1>Employee Payroll Detail</h1>
          <button className="pr-wd-banner-back" onClick={onBack}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
            Back to Summary
          </button>
        </div>
        <div className="pr-wd-info-row">
          <div className="pr-wd-info-avatar">{initialsOf(row.name)}</div>
          <div className="pr-wd-info-field"><span className="l">Employee No.</span><span className="v">{row.id}</span></div>
          <div className="pr-wd-info-field"><span className="l">Employee Name</span><span className="v">{row.name}</span></div>
          <div className="pr-wd-info-field"><span className="l">Station</span><span className="v">FFB Reception</span></div>
          <div className="pr-wd-info-field"><span className="l">Position</span><span className="v">{row.role}</span></div>
          <div className="pr-wd-info-field"><span className="l">Shift</span><span className="v">{row.shift}</span></div>
          <div className="pr-wd-info-field"><span className="l">Payroll Month</span><span className="v">July 2026</span></div>
          <div className="pr-wd-info-field pr-wd-info-spacer">
            <span className="l">Payroll Status</span>
            <span className={`pr-status-pill ${payrollStatus}`}>{STATUS_LABEL[payrollStatus]}</span>
          </div>
        </div>
      </div>

      <div className="pr-wd-body">
        <div className="pr-wd-sidebar">
          <div className="pr-wd-card pr-wd-side-card">
            <h3>Earnings Summary</h3>
            <div className="pr-wd-side-row"><span>Wage Pay</span><span className="amt">RM {fmt(row.wages)}</span></div>
            <div className="pr-wd-side-row"><span>Piece Rate Earnings</span><span className="amt">RM {fmt(row.piece)}</span></div>
            <div className="pr-wd-side-row"><span>Overtime (OT)</span><span className="amt">RM {fmt(row.ot)}</span></div>
            <div className="pr-wd-side-row"><span>Allowances</span><span className="amt">RM {fmt(row.incentive)}</span></div>
            <div className="pr-wd-side-row"><span>Incentives</span><span className="amt">RM {fmt(row.others)}</span></div>
            <div className="pr-wd-side-row"><span>Deduction</span><span className="amt negative">−RM {fmt(row.ded)}</span></div>
            <div className="pr-wd-side-row total"><span>Gross Pay</span><span className="amt">RM {fmt(gross)}</span></div>
            <div className="pr-wd-net-pay-banner"><span className="l">NET PAY</span><span className="v">RM {fmt(net)}</span></div>
          </div>

          <div className="pr-wd-card pr-wd-side-card">
            <h3>Rate Information</h3>
            <div className="pr-wd-side-row"><span>Daily Wage Rate</span><span className="amt">RM {fmt(row.dailyRate)}</span></div>
            <div className="pr-wd-side-row"><span>OT Rate (per hour)</span><span className="amt">RM {fmt(otRate)}</span></div>
            <div className="pr-wd-side-row"><span>Effective From</span><span className="amt">01/01/2026</span></div>
          </div>

          <div className="pr-wd-card pr-wd-side-card">
            <h3>Payroll Summary</h3>
            <div className="pr-wd-side-row"><span>Total Earnings</span><span className="amt">RM {fmt(gross)}</span></div>
            <div className="pr-wd-side-row"><span>Total Deductions</span><span className="amt negative">−RM {fmt(row.ded)}</span></div>
            <div className="pr-wd-side-row"><span>Net Pay</span><span className="amt">RM {fmt(net)}</span></div>
            <div className="pr-wd-side-row"><span>Payment Month</span><span className="amt">July 2026</span></div>
          </div>
        </div>

        <div className="pr-wd-main">
          <div className="pr-wd-tabs">
            <button className={`pr-wd-tab ${activeTab === 'cage' ? 'active' : ''}`} onClick={() => setActiveTab('cage')}>Cage Records</button>
            <button className={`pr-wd-tab ${activeTab === 'attendance' ? 'active' : ''}`} onClick={() => setActiveTab('attendance')}>Attendance &amp; Leave</button>
            <button className={`pr-wd-tab ${activeTab === 'incentive' ? 'active' : ''}`} onClick={() => setActiveTab('incentive')}>Incentive / Allowance</button>
            <button className={`pr-wd-tab ${activeTab === 'deduction' ? 'active' : ''}`} onClick={() => setActiveTab('deduction')}>Others &amp; Deduction</button>
          </div>

          {activeTab === 'cage' && (
            <>
              <div className="pr-kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                <MiniTile color="blue" icon={<CagesIcon />} label="Total Cages" value={num(totalCages)} />
                <MiniTile color="green" icon={<CheckSquareIcon />} label="1-4 Cages" value={num(total1to4)} />
                <MiniTile color="amber" icon={<PlusAxisIcon />} label="> 4 Cages" value={num(totalOver4)} />
                <MiniTile color="green" icon={<DollarIcon />} label="Total Cage Earnings" value={`RM ${fmt(row.piece)}`} />
              </div>

              <div className="pr-wd-filters">
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                <span className="muted">–</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                <select value={cageStatusFilter} onChange={(e) => setCageStatusFilter(e.target.value as 'all' | CageStatus)}>
                  <option value="all">All Status</option>
                  <option value="verified">Verified</option>
                  <option value="pending">Pending</option>
                </select>
                <button className="pr-btn ghost" onClick={handleSearch}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
                  Search
                </button>
              </div>

              <div className="pr-table-card">
                <div className="pr-table-scroll">
                  <table className="pr-data">
                    <colgroup>
                      <col style={{ width: 36 }} /><col style={{ width: 92 }} /><col style={{ width: 96 }} />
                      <col style={{ width: 100 }} /><col style={{ width: 84 }} /><col style={{ width: 84 }} />
                      <col style={{ width: 100 }} /><col style={{ width: 90 }} /><col style={{ width: 70 }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>No.</th><th>Date</th><th>Time</th>
                        <th className="right">Total Cages Tipped</th><th className="right">1-4 Cages</th><th className="right">&gt; 4 Cages</th>
                        <th className="right">Amount (RM)</th><th>Status</th><th className="right">Edit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCage.length === 0 && (
                        <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: '1.2rem' }}>No cage records for this worker.</td></tr>
                      )}
                      {filteredCage.map((r) => (
                        cageEditingNo === r.no
                          ? <CageEditRow key={r.no} record={r} onSave={(patch) => saveCageRow(r.no, patch)} onCancel={() => setCageEditingNo(null)} />
                          : <CageViewRow key={r.no} record={r} onEdit={() => setCageEditingNo(r.no)} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="pr-table-foot">
                  <span>Showing 1 to {filteredCage.length} of {filteredCage.length} records</span>
                </div>
              </div>
            </>
          )}

          {activeTab === 'attendance' && (
            <>
              <div className="pr-kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                <MiniTile color="green" icon={<CheckSquareIcon />} label="Days Present" value={String(row.days)} />
                <MiniTile color="red" icon={<XCircleIcon />} label="Days Absent" value="0" />
                <MiniTile color="amber" icon={<CalendarIcon />} label="Leave Taken (Paid)" value={String(row.leaveDays)} />
                <MiniTile color="blue" icon={<ClockIcon />} label="Late Arrivals" value={String(attendance.filter((a) => a.status === 'late').length)} />
              </div>

              <div className="pr-wd-card pr-wd-wagecalc-card">
                <div className="pr-wd-wagecalc-head">
                  <h3>Wage Calculation</h3>
                  <span className="muted small">Daily wage — paid in addition to Piece Rate Earnings, using the same formula for every FFB Reception worker</span>
                </div>
                <div className="pr-wd-wagecalc-strip">
                  <div className="pr-wd-wagecalc-seg">
                    <span className="l">Days Worked</span>
                    <span className="v">{row.days} days</span>
                  </div>
                  <div className="pr-wd-wagecalc-op">+</div>
                  <div className="pr-wd-wagecalc-seg">
                    <span className="l">Paid Leave</span>
                    <span className="v">{row.leaveDays} days</span>
                  </div>
                  <div className="pr-wd-wagecalc-op">=</div>
                  <div className="pr-wd-wagecalc-seg">
                    <span className="l">Total Payable Days</span>
                    <span className="v">{totalPayableDays} days</span>
                  </div>
                  <div className="pr-wd-wagecalc-op">×</div>
                  <div className="pr-wd-wagecalc-seg">
                    <span className="l">Daily Wage Rate</span>
                    <span className="v">RM {fmt(row.dailyRate)}</span>
                  </div>
                  <div className="pr-wd-wagecalc-op">=</div>
                  <div className="pr-wd-wagecalc-seg result">
                    <span className="l">Total Wages</span>
                    <span className="v">RM {fmt(row.wages)}</span>
                  </div>
                </div>
                <p className="pr-wd-wagecalc-note">
                  Every FFB Reception worker is paid <b>Piece Rate (cages tipped) + Wage Pay (days worked × daily rate)</b> — the two are added together, not one or the other. Daily wage is fixed at hiring and paid regardless of cage output. <b>Paid leave counts the same as a day worked</b> — it isn't deducted from wages, so Total Payable Days includes both days actually worked and approved paid leave days.
                </p>
              </div>

              <div className="pr-table-card">
                <div className="pr-table-scroll">
                  <table className="pr-data">
                    <thead>
                      <tr><th>Date</th><th>Clock In</th><th>Clock Out</th><th className="right">Hours</th><th>Status</th><th>Remarks</th><th className="right">Edit</th></tr>
                    </thead>
                    <tbody>
                      {attendance.map((a) => (
                        <tr key={a.date}>
                          <td>{a.date}</td>
                          <td>{a.clockIn}</td>
                          <td>{a.clockOut}</td>
                          <td className="right">{a.hours.toFixed(1)}</td>
                          <td><span className={`pr-status-pill ${a.status === 'present' ? 'approved' : a.status === 'late' ? 'pending' : 'verified'}`}>{a.status === 'present' ? 'Present' : a.status === 'late' ? 'Late' : 'On Leave'}</span></td>
                          <td className="wrap">{a.remarks || '—'}</td>
                          <td className="right"><button className="pr-icon-btn"><PencilIcon /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {activeTab === 'incentive' && (
            <>
              <div className="pr-kpi-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                <MiniTile color="green" icon={<ClockIcon />} label="Total Allowances" value={`RM ${fmt(row.incentive)}`} />
                <MiniTile color="blue" icon={<PlusAxisIcon />} label="Total Incentives" value={`RM ${fmt(row.others)}`} />
              </div>
              <div className="pr-table-card">
                <div className="pr-table-scroll">
                  <table className="pr-data">
                    <thead><tr><th>Type</th><th className="right">Amount (RM)</th><th className="right">Edit</th></tr></thead>
                    <tbody>
                      {incentiveRows.map((r) => (
                        <tr key={r.key}>
                          <td>{r.label}</td>
                          <td className="right">
                            <EditableAmount
                              value={r.amt}
                              editing={incentiveEditing === r.key}
                              onEdit={() => setIncentiveEditing(r.key)}
                              onCancel={() => setIncentiveEditing(null)}
                              onSave={(v) => {
                                setIncentiveRows((rows) => rows.map((x) => (x.key === r.key ? { ...x, amt: v } : x)))
                                setIncentiveEditing(null)
                              }}
                            />
                          </td>
                          <td />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {activeTab === 'deduction' && (
            <>
              <div className="pr-kpi-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                <MiniTile color="red" icon={<XCircleIcon />} label="Penalties" value={`−RM ${fmt(deductionRows[0].amt)}`} />
                <MiniTile color="red" icon={<ReceiptIcon />} label="Other Deductions" value={`−RM ${fmt(deductionRows[1].amt)}`} />
              </div>
              <div className="pr-table-card">
                <div className="pr-table-scroll">
                  <table className="pr-data">
                    <thead><tr><th>Type</th><th className="right">Amount (RM)</th><th className="right">Edit</th></tr></thead>
                    <tbody>
                      {deductionRows.map((r) => (
                        <tr key={r.key}>
                          <td>{r.type}</td>
                          <td className="right">
                            <EditableAmount
                              value={r.amt}
                              negative
                              editing={deductionEditing === r.key}
                              onEdit={() => setDeductionEditing(r.key)}
                              onCancel={() => setDeductionEditing(null)}
                              onSave={(v) => {
                                setDeductionRows((rows) => rows.map((x) => (x.key === r.key ? { ...x, amt: v } : x)))
                                setDeductionEditing(null)
                              }}
                            />
                          </td>
                          <td />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="pr-chart-card">
        <div className="pr-chart-title">Net Pay Trend (2026)</div>
        <NetPayTrendChart months={YTD_MONTHS} values={history} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function MiniTile({ color, icon, label, value }: { color: string; icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="pr-kpi-card">
      <div className="pr-kpi-top">
        <div className={`pr-kpi-icon ${color}`}>{icon}</div>
        <div className="pr-kpi-label">{label}</div>
      </div>
      <div className="pr-kpi-value" style={{ fontSize: '1.15rem' }}>{value}</div>
    </div>
  )
}

function CageViewRow({ record: r, onEdit }: { record: CageRecord; onEdit: () => void }) {
  return (
    <tr>
      <td className="muted">{r.no}</td>
      <td>{r.date}</td>
      <td>{r.time}</td>
      <td className="right">{r.total}</td>
      <td className="right">{r.c14}</td>
      <td className="right">{r.c4p}</td>
      <td className="right">{fmt(r.amt)}</td>
      <td><span className={`pr-status-pill ${r.status === 'verified' ? 'verified' : 'pending'}`}>{r.status === 'verified' ? 'Verified' : 'Pending'}</span></td>
      <td className="right"><button className="pr-icon-btn" onClick={onEdit}><PencilIcon /></button></td>
    </tr>
  )
}

function CageEditRow({ record: r, onSave, onCancel }: { record: CageRecord; onSave: (patch: Partial<CageRecord>) => void; onCancel: () => void }) {
  const [date, setDate] = useState(r.date)
  const [time, setTime] = useState(r.time)
  const [c14, setC14] = useState(String(r.c14))
  const [c4p, setC4p] = useState(String(r.c4p))
  const [amt, setAmt] = useState(r.amt.toFixed(2))
  const [status, setStatus] = useState<CageStatus>(r.status)

  function save() {
    const c14n = Number(c14) || 0
    const c4pn = Number(c4p) || 0
    onSave({ date, time, c14: c14n, c4p: c4pn, total: c14n + c4pn, amt: parseFloat(amt) || 0, status })
  }

  return (
    <tr>
      <td className="muted">{r.no}</td>
      <td><input className="pr-row-input" data-field="date" value={date} onChange={(e) => setDate(e.target.value)} /></td>
      <td><input className="pr-row-input" data-field="time" value={time} onChange={(e) => setTime(e.target.value)} /></td>
      <td className="right">{Number(c14) + Number(c4p)}</td>
      <td className="right"><input className="pr-row-input" value={c14} onChange={(e) => setC14(e.target.value)} /></td>
      <td className="right"><input className="pr-row-input" value={c4p} onChange={(e) => setC4p(e.target.value)} /></td>
      <td className="right"><input className="pr-row-input" value={amt} onChange={(e) => setAmt(e.target.value)} /></td>
      <td>
        <select className="pr-row-input" value={status} onChange={(e) => setStatus(e.target.value as CageStatus)}>
          <option value="verified">Verified</option>
          <option value="pending">Pending</option>
        </select>
      </td>
      <td className="right" style={{ display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
        <button className="pr-icon-btn" style={{ color: 'var(--pr-good-text)' }} onClick={save}><CheckIcon /></button>
        <button className="pr-icon-btn" style={{ color: '#b23030' }} onClick={onCancel}><XIcon /></button>
      </td>
    </tr>
  )
}

function EditableAmount({
  value, negative, editing, onEdit, onCancel, onSave,
}: {
  value: number
  negative?: boolean
  editing: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: (v: number) => void
}) {
  const [draft, setDraft] = useState(value.toFixed(2))
  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
        <input className="pr-row-input" style={{ width: 74 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="pr-icon-btn" style={{ color: 'var(--pr-good-text)' }} onClick={() => onSave(parseFloat(draft) || 0)}><CheckIcon /></button>
        <button className="pr-icon-btn" style={{ color: '#b23030' }} onClick={onCancel}><XIcon /></button>
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
      {negative ? '−' : ''}RM {fmt(value)}
      <button className="pr-icon-btn" onClick={onEdit}><PencilIcon /></button>
    </span>
  )
}

function NetPayTrendChart({ months, values }: { months: string[]; values: number[] }) {
  const W = 900, H = 300
  const padL = 78, padR = 24, padT = 30, padB = 40
  const plotW = W - padL - padR, plotH = H - padT - padB
  const yMin = Math.floor(Math.min(...values) / 1000) * 1000 - 1000
  const yMax = Math.ceil(Math.max(...values) / 1000) * 1000 + 1000
  const xAt = (i: number) => padL + (i / (values.length - 1)) * plotW
  const yAt = (v: number) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH
  const ticks: number[] = []
  for (let v = yMin; v <= yMax; v += 1000) ticks.push(v)

  const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(v)}`).join(' ')
  const areaPath = `${linePath} L ${xAt(values.length - 1)} ${yAt(yMin)} L ${xAt(0)} ${yAt(yMin)} Z`

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={280}>
        <defs>
          <linearGradient id="pr-wd-net-grad" x1={0} y1={0} x2={0} y2={1}>
            <stop offset="0%" stopColor="var(--pr-brand)" stopOpacity={0.32} />
            <stop offset="100%" stopColor="var(--pr-brand)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={yAt(v)} y2={yAt(v)} stroke="var(--pr-grid-line)" strokeWidth={1} />
            <text x={padL - 12} y={yAt(v) + 4} fill="var(--pr-muted)" fontSize={12} textAnchor="end">RM {v.toLocaleString('en-US')}</text>
          </g>
        ))}
        {months.map((m, i) => (
          <text key={m} x={xAt(i)} y={H - padB + 24} fill="var(--pr-muted)" fontSize={12} textAnchor="middle">{m}</text>
        ))}
        <path d={areaPath} fill="url(#pr-wd-net-grad)" stroke="none" />
        <path d={linePath} fill="none" stroke="var(--pr-brand-strong)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        {values.map((v, i) => {
          const dip = i > 0 && v < values[i - 1]
          const ly = dip ? yAt(v) + 20 : yAt(v) - 14
          return (
            <g key={i}>
              <circle cx={xAt(i)} cy={yAt(v)} r={4.5} fill="var(--pr-brand-strong)" stroke="var(--surface)" strokeWidth={2} />
              <text x={xAt(i)} y={ly} textAnchor="middle" fontSize={12.5} fontWeight={700} fill="var(--text)">{fmt(v)}</text>
            </g>
          )
        })}
      </svg>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.45rem', fontSize: '0.8rem', color: 'var(--pr-text-secondary)' }}>
        <svg width="22" height="10" viewBox="0 0 22 10"><line x1={0} y1={5} x2={22} y2={5} stroke="var(--pr-brand-strong)" strokeWidth={2} strokeDasharray="1,4" strokeLinecap="round" /><circle cx={11} cy={5} r={2.6} fill="var(--pr-brand-strong)" /></svg>
        Net Pay (RM)
      </div>
    </div>
  )
}

function PencilIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg> }
function CheckIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg> }
function XIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg> }
function CagesIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8 12 3 3 8l9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /></svg> }
function CheckSquareIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m9 12 2 2 4-4" /></svg> }
function PlusAxisIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M2 12h20" /></svg> }
function XCircleIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" /></svg> }
function CalendarIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18" /></svg> }
function ClockIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg> }
function DollarIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v10" /><path d="M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1-3 2.3c0 3 6 1.5 6 4.4 0 1.4-1.3 2.3-3 2.3s-3-1-3-2.3" /></svg> }
function ReceiptIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M9 15h6" /></svg> }
