# Piece Rate & Payroll System

A React + TypeScript web app for a palm oil mill's piece-rate payroll, backed by
Supabase and deployable to GitHub Pages. This repo is the **skeleton**: auth,
role-based routing, the Supabase client, and placeholder pages ready to build on.

Stack: Vite · React 18 · TypeScript · React Router (HashRouter) · Supabase JS.

## Roles

`admin` · `manager` · `engineer` · `operator` · `worker` — enforced in the database
via Row Level Security. The frontend only hides links; the backend is the real gate.

## 1. Set up the database

In a new Supabase project, open the SQL editor and run [`supabase/setup.sql`](supabase/setup.sql)
once. It creates the core tables, security policies, the auto-profile trigger, and
seeds the 7 stations.

## 2. Run locally

```bash
npm install
cp .env.example .env    # then fill in your Supabase URL + anon key
npm run dev
```

Find the two values in Supabase under **Project Settings → API**:
`Project URL` → `VITE_SUPABASE_URL`, `anon public` key → `VITE_SUPABASE_ANON_KEY`.
Both are safe in the browser — access is protected by RLS.

## 3. Create your admin user

1. Sign up a user (via the app's sign-in screen after enabling email auth in Supabase,
   or in the Supabase **Authentication** dashboard). A profile row is created
   automatically as `worker`.
2. Promote yourself to admin. In the SQL editor, while logged in as that user via the
   app, run:

   ```sql
   update access_profiles set role = 'admin' where id = auth.uid();
   ```

   Or set the `role` to `admin` directly on your row in the `access_profiles` table
   editor.

## 4. Deploy to GitHub Pages

1. Push this repo to GitHub.
2. In the repo, go to **Settings → Secrets and variables → Actions** and add two
   repository secrets: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Push to `main`. The included workflow (`.github/workflows/deploy.yml`) builds and
   publishes automatically. Your site appears at
   `https://<your-username>.github.io/<repo-name>/`.

The app uses `HashRouter` and a relative asset base (`base: './'`), so it works on
Pages without any repo-name configuration or 404 redirect tricks.

## 5. Point the auth emails at your site

Do this once, or every password-reset link will open a page that does not exist —
on a phone that shows up as *"Safari cannot connect to the server"*.

In Supabase, open **Authentication → URL Configuration** and set:

- **Site URL** — `https://<your-username>.github.io/<repo-name>/`
  (it starts as `http://localhost:3000`, which no phone can reach)
- **Redirect URLs** — add both of these, one per line:
  - `https://<your-username>.github.io/<repo-name>/`
  - `http://localhost:5173/` (only if you also want reset links to work in dev)

Supabase ignores any `redirectTo` that is not on the Redirect URLs list and quietly
falls back to the Site URL, so a missing entry looks exactly like a broken link.

The emailed link comes back with its tokens in the URL fragment, which is also where
`HashRouter` keeps its routes. [`src/lib/authLink.ts`](src/lib/authLink.ts) reads them
out before the router starts, and `ResetPasswordGate` then asks for the new password.

## Project structure

```
src/
  lib/supabase.ts            Supabase client + shared types (Role, Profile)
  context/AuthContext.tsx    Session + profile (role) loading
  components/
    ProtectedRoute.tsx       Auth + role guard for route groups
    Layout.tsx               Top bar, role-aware nav, sign out
  pages/
    Login.tsx                Email/password sign in
    Dashboard.tsx            Landing page
    Production.tsx           Placeholder — production entry
    Payroll.tsx              Placeholder — payroll runs & adjustments
    Settings.tsx             Placeholder — stations/jobs/workers/rates
    Unauthorized.tsx         Shown when a role lacks access
  App.tsx                    Routes + role restrictions
  main.tsx                   HashRouter + AuthProvider
```

## What to build next

The placeholder pages map to the backend modules. Natural next steps: the Settings
CRUD screens (stations, jobs, workers, rates), then one station's production entry
form end-to-end, then the payroll run + review flow.

## Notes

- Login uses email/password. For shop-floor workers without email, Supabase Auth also
  supports phone OTP and magic links — swap the sign-in method in `Login.tsx` when ready.
- Never put the Supabase `service_role` key in this frontend. Only the anon key belongs here.
