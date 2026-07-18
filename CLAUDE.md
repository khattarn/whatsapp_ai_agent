# whatsapp_ai_agent — repo notes

## This is the canonical checkout

This folder (`C:\Projects\whatsapp-agent`, tracking `github.com/khattarn/whatsapp_ai_agent`)
is the single canonical local checkout for this repo. Other local clones of this same
repo may exist on other machines/paths — they are not authoritative. If you find or
create another clone, treat it as disposable: push anything useful from it here, don't
develop in it long-term.

**Always run this before starting any work in this repo:**

```
git fetch origin && git log HEAD..origin/main --oneline
```

If that shows commits, `git pull`/merge them in before writing any new code. Two
independent local checkouts each writing new features into `netlify/functions/webhook.js`
without pulling first caused a real (if easily-resolved) merge conflict on 2026-07-18 —
see git log around commits `72936c9` / `dd964e7` for the incident if useful context.

## webhook.js — who owns which part

`netlify/functions/webhook.js` is a single shared Meta webhook handler for **multiple
WhatsApp numbers/businesses** (looked up per-request by `phone_number_id` against the
`businesses` Supabase table), plus Instagram/Facebook Messenger. Know which part you're
touching before editing:

- **`business.service_mode === 'legal_aid'`** → `handleLegalAid()` — the Nyaya Saathi
  (LegalAid AI) chatbot, for phone number 9871422567. This delegates Research/Draft/
  eCourts logic to a *separate* repo/gateway: `whatsapp-service.js` in
  `github.com/khattarn/nyaya-sathi-new` (Beta3), called via `callGateway()`. Changes to
  actual AI behavior, quota, or draft generation for LegalAid live over there, not here.
- **Everything else** (`else` branch, plus the Instagram/Facebook handlers) → the
  generic multi-tenant customer-service bot used by other businesses (e.g. Garment
  Retail on 9971193600) and broadcast/catalogue features.

These two are logically independent products sharing one file. If a future edit only
concerns one of them, keep it scoped to that block — don't refactor shared helpers
(`sendWhatsAppMessage`, `upsertContact`, etc.) without checking both call sites still work.

If this file keeps causing conflicts between LegalAid-side and other-business-side work,
consider splitting `handleLegalAid()` and its helpers into their own dedicated Netlify
function, with the LegalAid WABA's Meta webhook subscription pointed at that new function
instead of this shared one. Not urgent — only worth doing if divergence becomes a
recurring pattern rather than a one-off.