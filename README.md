# VYRO.CHAT — deployable starter

A mobile-first random stranger chat web app based on the supplied VYRO.CHAT product specification. It uses Next.js on Vercel and Supabase for anonymous auth, database, matchmaking RPCs, and realtime messages.

## Included

- Responsive dark/neon VYRO interface
- Anonymous Supabase sign-in (no email/password form)
- Interest selection and database-backed matching queue
- Realtime text chat, next stranger, disconnect state
- Report-and-disconnect flow
- Row Level Security policies, message length limits, and server-side matching functions
- Vercel-ready Next.js project

## Updating an existing database

The matching function changed (it now takes a `p_reset` argument and ignores stale queue entries). If you already ran an older `schema.sql`, run the new one again; it is safe to re-run.

## Free-tier reality check

The app is designed to fit free tiers for a small prototype, but no provider promises unlimited free hosting. Supabase and Vercel quotas, inactivity policies, bandwidth, database, and realtime limits apply and can change. This starter does not include voice/video calling, image uploads, a staffed moderation dashboard, end-to-end encryption, or production-grade anti-abuse infrastructure. Do not market it as “zero logs” or “encrypted” until those properties are actually implemented and independently reviewed.

## Deploy from an iPhone

You can do the setup in Safari, but editing files is easier with GitHub's website. No computer is required.

### 1. Create the Supabase backend

1. Create a free project at https://supabase.com/.
2. Open **SQL Editor** → **New query**.
3. Open `supabase/schema.sql` from this project, copy all its contents, paste them into SQL Editor, and run it.
4. In **Authentication → Sign In / Providers** (or Authentication settings), enable **Anonymous Sign-Ins**. Exact menu wording may change.
5. In **Project Settings → API** (or Connect), copy the Project URL and the anon/publishable client key. Never put a `service_role` secret in the browser or in a `NEXT_PUBLIC_` variable.
6. In **Database → Publications / Realtime**, confirm `messages` and `chat_sessions` are enabled for `supabase_realtime` if the SQL Editor reported the publication is missing.

### 2. Upload this project to GitHub

1. Create a new repository at https://github.com/.
2. Upload all files and folders from this ZIP, keeping the folder structure. The `app/`, `lib/`, and `supabase/` folders must be at the repository root alongside `package.json`.
3. Do not upload `.env.local` or any secret key. The ZIP only contains `.env.example` as a template.

### 3. Deploy to Vercel

1. Sign in at https://vercel.com/ with GitHub.
2. Choose **Add New → Project**, import your repository, and keep the Next.js defaults.
3. Add these Environment Variables in Vercel project settings:
   - `NEXT_PUBLIC_SUPABASE_URL` = your Supabase project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your Supabase anon/publishable client key
4. Deploy. If you change environment variables later, redeploy.

### 4. Test with two people

1. Open the deployed site in two separate browsers/devices (or a normal and private tab).
2. Pick at least one shared interest and tap **Find a Stranger** in both.
3. Send a message and verify it appears in the other browser.
4. Test Next Stranger, disconnect, report, and reload.

## Local development (optional)

Requires Node.js 18.17+ or 20+. Copy `.env.example` to `.env.local`, fill in the two Supabase variables, then run:

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Known prototype limitations

- The matching queue uses polling while searching; keep the page open.
- A stranger may be matched after the initial shared-interest pass only if their selected interests overlap; the UI suggests choosing more interests if no match appears.
- Reports are stored in the database but this ZIP does not include a staffed moderation console or automatic enforcement.
- Browser anonymous identities are not a substitute for robust account recovery or long-term bans.
- No video chat, audio calls, media attachments, end-to-end encryption, or admin panel is included in this first deployable version.
- Anonymous sign-in can be abused; review Supabase auth protections and quotas before sharing publicly.

## Security notes

- Browser code uses only the Supabase anon/publishable key; RLS restricts data access.
- Never add the Supabase service-role key to frontend code.
- This is a prototype starter, not a security audit. Test and review before inviting the public.
