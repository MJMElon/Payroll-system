import { useEffect, useState } from 'react'
import { supabase, type Grade } from '../../lib/supabase'
import {
  effectiveCapabilities,
  runsWholeMill,
  stationTierOf,
  tagClass,
} from '../../lib/tags'

/* ------------------------------------------------------------------ */
/* Who reaches whom.                                                   */
/*                                                                     */
/* Nothing is set on this page. Every answer here is DERIVED from the  */
/* tier tags themselves — the same helpers the modules use — so the    */
/* sheet cannot drift from what the app actually does. It exists       */
/* because the rules were only visible by using the app: a tag says    */
/* what it may DO, but never whose work it may see.                    */
/*                                                                     */
/* The rule the whole system runs on is one sentence: a tier reaches    */
/* ITSELF and everything BELOW it, never upward. Tier numbers count     */
/* down the ranks, so "below" means a LARGER tier number.               */
/* ------------------------------------------------------------------ */

/** "Tier 3 and below", or just the tag's own name when it is the last. */
function reachLabel(g: Grade, grades: Grade[]): string {
  const below = grades.filter((x) => x.sort_order > g.sort_order)
  if (below.length === 0) return `${g.name} only`
  return `${g.name} + ${below.length} tier${below.length === 1 ? '' : 's'} below`
}

/** The tags a tier reaches, itself first, for the detail line. */
function reaches(g: Grade, grades: Grade[]): Grade[] {
  return grades.filter((x) => x.sort_order >= g.sort_order).sort((a, b) => a.sort_order - b.sort_order)
}

export default function TierReachTab() {
  const [grades, setGrades] = useState<Grade[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    supabase
      .from('grades')
      .select('*')
      .order('sort_order')
      .then(({ data, error }) => {
        if (error) setError(error.message)
        setGrades((data ?? []) as Grade[])
        setLoading(false)
      })
  }, [])

  if (loading) return <p className="muted">Loading…</p>

  const stationTier = stationTierOf(grades)

  return (
    <div className="card stack">
      <div className="row-form spread">
        <h3>Who each tier can see</h3>
      </div>

      {error && <div className="error">{error}</div>}

      <p className="muted small" style={{ margin: 0 }}>
        Read-only. Every line is worked out from the tier tags, so it always
        matches what the modules actually do — change a tag and this changes
        with it. The rule underneath all of it: a tier reaches its own rank and
        every rank below, never upward. Work that carries no tier tag is open to
        everyone.
      </p>

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Tier</th>
              <th>Stations</th>
              <th>Work records it can see</th>
              <th>Piece rate contracts it can see</th>
              <th>Work entry</th>
              <th>Piece rate</th>
              <th>Can set tier for</th>
            </tr>
          </thead>
          <tbody>
            {grades.length === 0 && (
              <tr><td colSpan={7} className="muted">No tier tags yet.</td></tr>
            )}
            {grades.map((g) => {
              const caps = effectiveCapabilities(g)
              const millWide = runsWholeMill(g.sort_order, stationTier)
              const below = grades.filter((x) => x.sort_order > g.sort_order)
              // Tier 1 has nothing above it, so it is the one tier that may
              // also fill its own rank — the same rule canGiveTier applies.
              const canGive = g.sort_order === 1 ? grades : below
              const verbs = (on: string[]) =>
                on.length === 0 ? <span className="muted">—</span> : on.join(' · ')
              return (
                <tr key={g.id}>
                  <td>
                    <span className={tagClass(g.color)}>{g.name}</span>
                    <div className="muted small">Tier {g.sort_order}</div>
                  </td>
                  <td>{millWide ? 'Whole mill' : 'Own station tags'}</td>
                  <td>
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => setOpen(open === g.id ? null : g.id)}
                    >
                      {reachLabel(g, grades)}
                    </button>
                    {open === g.id && (
                      <div className="muted small" style={{ marginTop: '0.25rem' }}>
                        {reaches(g, grades).map((x) => x.name).join(', ')}
                      </div>
                    )}
                  </td>
                  <td>{reachLabel(g, grades)}</td>
                  <td>
                    {verbs(
                      [
                        caps.includes('data-entry') ? 'Add' : '',
                        caps.includes('verify') ? 'Verify' : '',
                        caps.includes('approve') ? 'Approve' : '',
                      ].filter(Boolean),
                    )}
                  </td>
                  <td>
                    {verbs(
                      [
                        caps.includes('rate-create') ? 'Add' : '',
                        caps.includes('rate-edit') ? 'Edit' : '',
                        caps.includes('rate-verify') ? 'Verify' : '',
                        caps.includes('rate-approve') ? 'Approve' : '',
                      ].filter(Boolean),
                    )}
                  </td>
                  <td>
                    {!caps.includes('team-assign') ? (
                      <span className="muted">—</span>
                    ) : canGive.length === 0 ? (
                      <span className="muted">nothing below</span>
                    ) : (
                      `${canGive.length} tier${canGive.length === 1 ? '' : 's'}`
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="muted small" style={{ margin: 0 }}>
        “Stations” is read from the tag names: the first tag naming a station is
        where the mill splits, and every tier above it runs the whole mill.
        Below that line a person sees only the station tags on their own account.
      </p>
    </div>
  )
}
