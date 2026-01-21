# SignalDesk (Cloudflare Workers)

Minimal feedback signal amplifier prototype built on a single Cloudflare Worker.

## What it does
- UI + API from one Worker (HTML pages, no build step)
- D1 as the system of record
- Workers AI for structured feedback analysis
- Optional Vectorize for semantic recall + Recall@3 eval

## Required bindings
- `DB` (D1)
- `AI` (Workers AI)
- `VEC` (Vectorize, optional)

If `AI` or `VEC` is missing, endpoints return clear JSON errors instead of crashing.

## Local dev
```bash
npx wrangler dev
```

## UI routes
- `GET /` Inbox page (submit + recent feedback)
- `GET /themes` Theme aggregation
- `GET /feedback?id=...` Feedback detail
- `GET /eval` Eval scorecard

## API routes
- `POST /api/feedback` JSON or form: `{ source, title?, body, customer_tier? }`
- `POST /api/feedback/bulk` JSON array or `{ items: [...] }` (ingestion testing; empty body uses built-in messy set)
- `POST /api/feedback/:id/analyze`
- `GET /api/themes`
- `GET /api/search?q=...`
- `POST /api/eval/seed` (empty body uses built-in golden set)
- `POST /api/eval/run`
- `GET /api/eval/latest`

## D1 schema
Expected tables (base tables assumed to already exist):
- `feedback(id, source, title, body, customer_tier, created_at)`
- `analysis(feedback_id, summary, theme, sentiment_label, sentiment_score, urgency_score, severity, suggested_owner, proposed_fix, analyzed_at, model)`

If `eval_runs` / `eval_cases` are missing, apply migration `migrations/0002_eval.sql`.

## Mock data
- `golden_dataset.json` can be POSTed to `/api/eval/seed` to seed a labeled golden set.
- `messy_data.json` can be POSTed to `/api/feedback/bulk` to stress-test ingestion.
