# Martal Redline Guard (GitHub Pages app)

Invite-gated team tool that reviews client contract redlines against Martal's own
standards, rates the severity/risk of each requested change, drafts copy-ready
counter-language, and learns from the team's decisions over time.

**Fully GitHub-hosted, no server of ours:**
- **GitHub Pages** serves this static single-page app (no build step).
- **Supabase** provides Google auth, the Postgres database (invite allowlist,
  reviews, precedents, knowledge base), and an **Edge Function** (`rg-review`) that
  holds the Anthropic key and runs the review. The key never touches the browser.

## How it works
- Sign in with Google (gated to an `@martalgroup.com` invite allowlist; admins manage the team on the **Team** tab).
- Upload a `.docx` (extracts tracked changes + margin comments = the redpen), a PDF, a Google Doc link, or paste text.
- Each change is rated HIGH / CAUTION / OK against the knowledge base, with copy-paste counter-language.
- Record the final call (accept / counter / reject) + why; these become precedents that steer future reviews.
- **History** tab lists every past review.

## Config (all public / safe to commit)
- Supabase URL + publishable (anon) key are in `app.js`. No secrets live here.
- The knowledge base lives in the Supabase `rg_kb` table (private); the review
  logic and Anthropic key live in the `rg-review` Edge Function (private).

## One-time setup (admin)
1. **Anthropic key:** set it as a Supabase secret so the Edge Function can call Claude:
   `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...` (or Dashboard -> Edge Functions -> Secrets).
2. **Auth redirect:** the Pages URL is already on the Supabase Auth redirect allowlist.
3. Sign in as `edward@martalgroup.com` (seeded admin) and invite the team on **Team**.

## Updating Martal's standards
Update the `rg_kb` table row (id = 1). The master markdown lives in the
`martal-redline-guard` repo's `KNOWLEDGE_BASE.md`.
