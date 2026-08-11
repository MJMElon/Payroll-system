// ---------------------------------------------------------------------------
// WHO GETS PAID from one approved work entry.
//
// A piece-rate work is priced per tier: the same station + work-name group
// holds one job row per entitled tier, each with its own rate. One approved
// entry pays the SUBMITTER at the tier it was recorded under, and ALSO every
// tier ABOVE that one that has a rate on the same work — each of them the
// entry's quantity at their own tier's rate. Tiers below the submitting one
// are never paid from that entry: an assistant station head's record pays
// the assistant and the station head, but not the operator; an operator's
// record pays all three.
//
// The higher-tier payee is resolved through the submitter's reporting line
// (the supervisor_id chain set on the Team Manage chart): the nearest upper
// in that chain whose tier matches the priced job. If the chain holds no
// one of that tier, no line is produced for it.
// ---------------------------------------------------------------------------

interface PayJob {
  id: string
  station_id: string
  grade_id: string | null
  name: string
}

interface PayProfile {
  id: string
  grade_id?: string | null
  supervisor_id?: string | null
}

interface PayGrade {
  id: string
  sort_order: number // 1 = highest tier
}

export interface EntryPayLine {
  /** Account being paid (null only on the legacy worker-row line). */
  userId: string | null
  workerId: string | null
  /** The job row (their tier's pricing of the work) this line pays on. */
  jobId: string
  /** True on the submitter's own line, false on derived upper-tier lines. */
  own: boolean
}

/**
 * Builds the entry → pay-lines expander from the reference data a report
 * already has. `hasRate` says whether a job row is actually priced — an
 * unpriced upper tier earns nothing and gets no line.
 */
export function makePayExpander(opts: {
  jobs: PayJob[]
  profiles: PayProfile[]
  grades: PayGrade[]
  hasRate: (jobId: string) => boolean
}) {
  const { jobs, profiles, grades, hasRate } = opts
  const jobById = new Map(jobs.map((j) => [j.id, j]))
  const profById = new Map(profiles.map((p) => [p.id, p]))
  const rankOf = new Map(grades.map((g) => [g.id, g.sort_order]))
  const groupKey = (j: PayJob) => `${j.station_id}|${j.name.trim().toLowerCase()}`
  const groups = new Map<string, PayJob[]>()
  for (const j of jobs) {
    const k = groupKey(j)
    const arr = groups.get(k)
    if (arr) arr.push(j)
    else groups.set(k, [j])
  }

  /** Nearest upper in the submitter's reporting line holding this tier. */
  function upperOfGrade(from: PayProfile, gradeId: string): string | null {
    const seen = new Set<string>([from.id])
    let cur = from.supervisor_id ? profById.get(from.supervisor_id) : undefined
    while (cur && !seen.has(cur.id)) {
      if (cur.grade_id === gradeId) return cur.id
      seen.add(cur.id)
      cur = cur.supervisor_id ? profById.get(cur.supervisor_id) : undefined
    }
    return null
  }

  return function payLinesOf(entry: {
    user_id: string | null
    worker_id?: string | null
    job_id: string
  }): EntryPayLine[] {
    const own: EntryPayLine = {
      userId: entry.user_id ?? null,
      workerId: entry.user_id ? null : entry.worker_id ?? null,
      jobId: entry.job_id,
      own: true,
    }
    const job = jobById.get(entry.job_id)
    const submitter = entry.user_id ? profById.get(entry.user_id) : undefined
    if (!job || !submitter) return [own]
    // The tier the record was submitted under — the job's own tier, falling
    // back to the submitter's tier for untagged jobs.
    const baseRank =
      rankOf.get(job.grade_id ?? '') ?? rankOf.get(submitter.grade_id ?? '')
    if (baseRank == null) return [own]

    const out = [own]
    for (const sib of groups.get(groupKey(job)) ?? []) {
      if (sib.id === job.id || !sib.grade_id) continue
      const rank = rankOf.get(sib.grade_id)
      if (rank == null || rank >= baseRank) continue // same tier or below
      if (!hasRate(sib.id)) continue
      const payee = upperOfGrade(submitter, sib.grade_id)
      if (payee) out.push({ userId: payee, workerId: null, jobId: sib.id, own: false })
    }
    return out
  }
}
