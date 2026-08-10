// ---------------------------------------------------------------------------
// AUDIT LOG — who changed what, when. Rows are written by DB triggers (see
// setup.sql: log_audit) on work entries, piece rates, payroll and user
// access; RLS restricts reading to admins / managers / tier 1.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { profileName, supabase, type Profile } from '../../lib/supabase'

interface AuditRow {
  id: string
  at: string
  actor: string | null
  action: string
  target: string
  target_id: string | null
  detail: Record<string, unknown> | null
}

const TARGET_LABEL: Record<string, string> = {
  production_entries: 'Work entry',
  jobs: 'Piece rate item',
  piece_rates: 'Piece rate price',
  payroll_runs: 'Payroll run',
  payroll_adjustments: 'Payroll adjustment',
  access_profiles: 'User access',
  grades: 'Tier tag',
  stations: 'Station tag',
  workers: 'Worker',
  photo_records: 'Photo record',
}

const ACTION_LABEL: Record<string, string> = {
  insert: 'Created',
  update: 'Changed',
  delete: 'Deleted',
}

/** "approval_status: approved, approved_by: x@y.com" — compact change list. */
function detailSummary(d: Record<string, unknown> | null): string {
  if (!d) return ''
  const skip = new Set(['id', 'created_at', 'updated_at'])
  const parts: string[] = []
  for (const [k, v] of Object.entries(d)) {
    if (skip.has(k)) continue
    const val =
      v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    parts.push(`${k}: ${val.length > 40 ? val.slice(0, 40) + '…' : val}`)
    if (parts.length >= 6) {
      parts.push('…')
      break
    }
  }
  return parts.join(' · ')
}

export default function AuditLogTab() {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [people, setPeople] = useState<Profile[]>([])
  const [target, setTarget] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      let q = supabase
        .from('shared_audit_log')
        .select('*')
        .order('at', { ascending: false })
        .limit(200)
      if (target) q = q.eq('target', target)
      const [{ data, error }, { data: p }] = await Promise.all([
        q,
        supabase.from('shared_profiles').select('id, full_name, email'),
      ])
      if (error) setError(error.message)
      else setError(null)
      setRows((data ?? []) as AuditRow[])
      setPeople((p ?? []) as Profile[])
      setLoading(false)
    }
    load()
  }, [target])

  const actorName = (id: string | null) => {
    if (!id) return 'System'
    const p = people.find((x) => x.id === id)
    return p ? profileName(p) : id.slice(0, 8)
  }

  return (
    <div className="card stack">
      <div className="row-form spread">
        <h3>Audit trail record</h3>
        <select
          className="filter-select"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          title="Filter by area"
        >
          <option value="">All areas</option>
          {Object.entries(TARGET_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Area</th>
                <th>What changed</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    Nothing logged yet — actions start appearing after the
                    audit triggers are installed (re-run setup.sql).
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted small" style={{ whiteSpace: 'nowrap' }}>
                    {new Date(r.at).toLocaleString(undefined, {
                      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </td>
                  <td>{actorName(r.actor)}</td>
                  <td>
                    <span
                      className={`badge ${
                        r.action === 'delete' ? 'off' : r.action === 'insert' ? 'ok' : 'mid'
                      }`}
                    >
                      {ACTION_LABEL[r.action] ?? r.action}
                    </span>
                  </td>
                  <td className="muted small">{TARGET_LABEL[r.target] ?? r.target}</td>
                  <td className="muted small" style={{ maxWidth: 420 }}>
                    {detailSummary(r.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
