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

## Workflow guide

SignalDesk has two main workflows:
- Production workflow: real feedback processing (messy or live tickets).
- Evaluation workflow: quality checks with the golden dataset.

### Production workflow (real feedback)
1. Ingest feedback
   - Web form: `GET /`
   - API: `POST /api/feedback`
2. Store raw feedback in D1 (`feedback` table).
3. Run AI analysis (Workers AI) and store results in D1 (`analysis` table).
4. Create embeddings (Workers AI) and upsert vectors into Vectorize (if bound).
5. Semantic similarity search when viewing a feedback detail page.

Example API:
```bash
curl -X POST https://signaldesk.workers.dev/api/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "source": "discord",
    "title": "wrangler tail not working",
    "body": "i cant see any logs when i run wrangler tail",
    "customer_tier": "Pro"
  }'
```

### Evaluation workflow (golden dataset)
Purpose: validate JSON quality, theme correctness, and Vectorize recall.

Steps:
1. Seed the golden dataset (50 labeled items, 10 known duplicate pairs).
2. Analyze all items (Workers AI) and store results.
3. Generate embeddings and upsert vectors.
4. For each duplicate pair, query top 3 matches and compute recall.
5. Record metrics in `eval_runs` and `eval_cases`.

Commands:
```bash
curl -X POST http://localhost:8787/api/eval/seed
curl -X POST http://localhost:8787/api/eval/run
curl http://localhost:8787/api/eval/latest
```

### How messy vs golden data is used
- `messy_data.json`: simulate real-world noisy intake (`POST /api/feedback/bulk`).
- `golden_dataset.json`: quality gate to measure analysis validity and recall.
