/**
 * The one refusal every gated page shows: a page the viewer's tier is not
 * ticked for says this and nothing else. One wording, used everywhere, so
 * a refusal reads the same in every module and never explains a page the
 * viewer cannot open anyway.
 */
export default function NoAccess() {
  return <p className="muted">You don't have access to this page.</p>
}
