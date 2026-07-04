import { Link } from 'react-router-dom'

export default function Unauthorized() {
  return (
    <div className="center">
      <div className="card auth">
        <h1>No access</h1>
        <p className="muted">Your role doesn’t have permission to view that page.</p>
        <Link className="btn ghost" to="/">
          Back to dashboard
        </Link>
      </div>
    </div>
  )
}
