# Director Runs

Track your way through directors' filmographies. Film data and images come from TMDB; your watched list and notes are saved in Supabase, so every device shows the same progress.

The site lives in `docs/` (served by GitHub Pages). `supabase/setup.sql` creates the database tables.

## One-time setup

### 1. Supabase (database and sign-in)
1. Create a free project at https://supabase.com.
2. **SQL Editor → New query**: paste all of `supabase/setup.sql`, click **Run**.
3. Click **Connect** at the top of the project dashboard (or go to **Project Settings → API Keys**): copy the **Project URL** and the **publishable key** (`sb_publishable_…`, or the legacy `anon` key) into `docs/config.js`.
4. **Authentication → URL Configuration**:
   - Site URL: `https://<your-github-username>.github.io/<repo-name>/`
   - Redirect URLs: add the same URL, plus `http://localhost:8000/` for testing locally.

### 2. GitHub Pages (hosting)
1. Create an empty repository on github.com (for example `director-runs`).
2. Push this folder to it (see below).
3. Repository **Settings → Pages**: Source "Deploy from a branch", branch `main`, folder `/docs`.

### 3. TMDB (film data)
1. Create a free account at https://www.themoviedb.org and request an API key under **Settings → API**.
2. Open the site, sign in, and paste the **API Read Access Token** when asked. It's stored in your Supabase account, not in the code.

## Run locally
```
cd docs
python -m http.server 8000
```
Then open http://localhost:8000/.
