import { useAuth } from '../context/AuthContext'

export default function Dashboard() {
  const { profile, session } = useAuth()

  return (
    <div className="stack">
      <div>
        <h1>Dashboard</h1>
        <p className="muted">
          Signed in as {session?.user.email}
          {profile?.role ? ` — role: ${profile.role}` : ''}.
        </p>
      </div>

      <div className="grid">
        <div className="card">
          <h3>Production</h3>
          <p className="muted small">
            Enter and review production records per station. Operators log their own
            station; admins and managers see everything.
          </p>
        </div>
        <div className="card">
          <h3>Payroll</h3>
          <p className="muted small">
            Run payroll for a period, review flagged lines, and record adjustments.
          </p>
        </div>
        <div className="card">
          <h3>Settings</h3>
          <p className="muted small">
            Stations, jobs, workers, piece rates, and operation standards.
          </p>
        </div>
      </div>

      <p className="muted small">
        This is the starting skeleton. Each area is a placeholder ready for you to build
        the real screens against the Supabase tables.
      </p>
    </div>
  )
}
