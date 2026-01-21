import {
	ALLOWED_SOURCES,
	MAX_BODY_CHARS,
	MAX_TIER_CHARS,
	MAX_TITLE_CHARS,
	type AnalysisRow,
	type Env,
} from './constants';
import { fetchFeedbackById, listRecentFeedback } from './db';
import { searchSimilar } from './vectorize';
import { htmlEscape, htmlResponse, requireBinding } from './utils';

function renderLayout(title: string, body: string): string {
	return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: "Georgia", "Times New Roman", serif;
      background: #f5f1e8;
      color: #1f1c17;
    }
    body {
      margin: 0;
      padding: 32px 20px 80px;
      background: linear-gradient(160deg, #f7efe1 0%, #f0f3f7 100%);
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 24px;
    }
    nav a {
      margin-right: 12px;
      color: #28324a;
      text-decoration: none;
      font-weight: 600;
    }
    h1 {
      font-size: 28px;
      margin: 0 0 6px;
    }
    h2 {
      font-size: 20px;
      margin: 24px 0 12px;
    }
    .card {
      background: #ffffff;
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 8px 24px rgba(31, 28, 23, 0.08);
      margin-bottom: 16px;
    }
    .grid {
      display: grid;
      gap: 16px;
    }
    .badge {
      display: inline-block;
      background: #f2d7a0;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
    }
    form label {
      display: block;
      margin-bottom: 8px;
      font-weight: 600;
    }
    input,
    textarea,
    select {
      width: 100%;
      margin-top: 6px;
      margin-bottom: 12px;
      padding: 8px;
      border-radius: 8px;
      border: 1px solid #d0c4b5;
      background: #fff;
    }
    button {
      background: #28324a;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      cursor: pointer;
    }
    .meta {
      font-size: 12px;
      color: #555;
    }
    .list {
      display: grid;
      gap: 12px;
    }
    .mono {
      font-family: "Courier New", monospace;
      font-size: 12px;
      background: #f7f5f1;
      padding: 6px 8px;
      border-radius: 6px;
      overflow-x: auto;
    }
    @media (min-width: 860px) {
      .grid {
        grid-template-columns: 1fr 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <div class="meta">SignalDesk</div>
      <h1>${htmlEscape(title)}</h1>
    </div>
    <nav>
      <a href="/">Inbox</a>
      <a href="/themes">Themes</a>
      <a href="/eval">Eval</a>
    </nav>
  </header>
  ${body}
</body>
</html>`;
}

export function renderMessagePage(title: string, message: string, status = 400): Response {
	const body = `<div class="card">${htmlEscape(message)}</div>`;
	return htmlResponse(renderLayout(title, body), status);
}

export async function renderInbox(env: Env): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return htmlResponse(renderLayout('Inbox', `<div class="card">Missing DB binding.</div>`), 500);
	const items = await listRecentFeedback(dbBinding.value);
	const listItems = items
		.map((item) => {
			const summary = item.summary ? `<div><strong>Summary:</strong> ${htmlEscape(item.summary)}</div>` : '';
			const theme = item.theme ? `<span class="badge">${htmlEscape(item.theme)}</span>` : '';
			const sentiment = item.sentiment_label ? `<span class="badge">${htmlEscape(item.sentiment_label)}</span>` : '';
			return `<div class="card">
        <div class="meta">${htmlEscape(item.source)} · ${htmlEscape(item.created_at)}</div>
        <div><a href="/feedback?id=${encodeURIComponent(item.id)}">${htmlEscape(item.title || 'Untitled')}</a></div>
        <div>${htmlEscape(item.body.slice(0, 220))}${item.body.length > 220 ? '…' : ''}</div>
        <div>${theme}${sentiment}</div>
        ${summary}
      </div>`;
		})
		.join('');
	const body = `<div class="grid">
  <div class="card">
    <h2>Submit Feedback</h2>
    <form method="post" action="/api/feedback">
      <label>Source
        <select name="source">
          ${ALLOWED_SOURCES.filter((s) => s !== 'golden')
				.map((source) => `<option value="${source}">${source}</option>`)
				.join('')}
        </select>
      </label>
      <label>Title
        <input name="title" maxlength="${MAX_TITLE_CHARS}" />
      </label>
      <label>Body
        <textarea name="body" rows="6" maxlength="${MAX_BODY_CHARS}"></textarea>
      </label>
      <label>Customer Tier
        <input name="customer_tier" maxlength="${MAX_TIER_CHARS}" />
      </label>
      <button type="submit">Submit</button>
    </form>
  </div>
  <div class="card">
    <h2>Mock data</h2>
    <div class="meta">Ingests the built-in messy dataset for load testing.</div>
    <form method="post" action="/api/feedback/bulk">
      <button type="submit">Ingest messy dataset</button>
    </form>
  </div>
  <div>
    <h2>Recent Feedback</h2>
    <div class="list">${listItems || '<div class="card">No feedback yet.</div>'}</div>
  </div>
</div>`;
	return htmlResponse(renderLayout('Inbox', body));
}

export async function renderThemes(env: Env): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return htmlResponse(renderLayout('Themes', `<div class="card">Missing DB binding.</div>`), 500);
	const db = dbBinding.value;
	const themeRows = await db.prepare('SELECT theme, COUNT(*) as count FROM analysis GROUP BY theme ORDER BY count DESC').all();
	const rows = themeRows.results || [];
	const listItems = await Promise.all(
		rows.map(async (row: any) => {
			const examples = await db
				.prepare('SELECT feedback_id FROM analysis WHERE theme = ? ORDER BY analyzed_at DESC LIMIT 2')
				.bind(row.theme)
				.all();
			const links = (examples.results || [])
				.map((ex: any) => `<a href="/feedback?id=${encodeURIComponent(ex.feedback_id)}">${htmlEscape(ex.feedback_id)}</a>`)
				.join(', ');
			return `<div class="card">
        <div><span class="badge">${htmlEscape(row.theme)}</span> ${row.count} items</div>
        <div class="meta">Examples: ${links || 'None'}</div>
      </div>`;
		})
	);
	const body = `<div class="list">${listItems.join('') || '<div class="card">No themes yet.</div>'}</div>`;
	return htmlResponse(renderLayout('Themes', body));
}

export async function renderFeedbackDetail(env: Env, id: string): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return htmlResponse(renderLayout('Feedback', `<div class="card">Missing DB binding.</div>`), 500);
	const db = dbBinding.value;
	const feedback = await fetchFeedbackById(db, id);
	if (!feedback) return htmlResponse(renderLayout('Feedback', `<div class="card">Not found.</div>`), 404);
	const analysis = (await db.prepare('SELECT * FROM analysis WHERE feedback_id = ?').bind(id).first()) as AnalysisRow | null;
	let similarHtml = '<div class="card">Vector search not configured.</div>';
	if (env.VEC) {
		const similar = await searchSimilar(env, feedback, 3);
		if (similar.items.length === 0) {
			similarHtml = '<div class="card">No similar feedback found.</div>';
		} else {
			similarHtml = `<div class="list">${similar.items
				.map(
					(item) => `<div class="card">
          <a href="/feedback?id=${encodeURIComponent(item.id)}">${htmlEscape(item.title || 'Untitled')}</a>
          <div class="meta">${htmlEscape(item.theme || 'Unlabeled')}</div>
        </div>`
				)
				.join('')}</div>`;
		}
	}
	const analysisHtml = analysis
		? `<div class="card">
      <div><span class="badge">${htmlEscape(analysis.theme)}</span><span class="badge">${htmlEscape(analysis.sentiment_label)}</span></div>
      <div><strong>Summary:</strong> ${htmlEscape(analysis.summary)}</div>
      <div><strong>Urgency:</strong> ${analysis.urgency_score} (${htmlEscape(analysis.severity)})</div>
      <div><strong>Suggested owner:</strong> ${htmlEscape(analysis.suggested_owner)}</div>
      <div><strong>Proposed fix:</strong> ${htmlEscape(analysis.proposed_fix)}</div>
    </div>`
		: `<div class="card">No analysis yet. <form method="post" action="/api/feedback/${encodeURIComponent(id)}/analyze"><button type="submit">Analyze</button></form></div>`;
	const body = `<div class="grid">
  <div>
    <div class="card">
      <div class="meta">${htmlEscape(feedback.source)} · ${htmlEscape(feedback.created_at)}</div>
      <h2>${htmlEscape(feedback.title || 'Untitled')}</h2>
      <div>${htmlEscape(feedback.body)}</div>
      <div class="meta">Tier: ${htmlEscape(feedback.customer_tier || 'n/a')}</div>
    </div>
    <h2>Analysis</h2>
    ${analysisHtml}
  </div>
  <div>
    <h2>Similar</h2>
    ${similarHtml}
  </div>
</div>`;
	return htmlResponse(renderLayout('Feedback', body));
}

export async function renderEval(env: Env): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return htmlResponse(renderLayout('Eval', `<div class="card">Missing DB binding.</div>`), 500);
	const db = dbBinding.value;
	const latest = (await db.prepare('SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT 1').first()) as any;
	const failures = await db
		.prepare('SELECT * FROM eval_cases WHERE json_valid = 0 OR theme_valid = 0 OR recall_hit = 0 ORDER BY rowid DESC LIMIT 10')
		.all();
	const runHtml = latest
		? `<div class="card">
      <div><strong>Run:</strong> ${htmlEscape(latest.id)}</div>
      <div class="meta">${htmlEscape(latest.created_at)} · model ${htmlEscape(latest.model)}</div>
      <div>JSON valid rate: ${latest.json_valid_rate ?? 'n/a'}</div>
      <div>Theme valid rate: ${latest.theme_valid_rate ?? 'n/a'}</div>
      <div>Recall@3: ${latest.recall_at_3 ?? 'n/a'}</div>
    </div>`
		: '<div class="card">No eval runs yet.</div>';
	const failureHtml = (failures.results || [])
		.map(
			(row: any) => `<div class="card">
      <div><a href="/feedback?id=${encodeURIComponent(row.feedback_id)}">${htmlEscape(row.feedback_id)}</a></div>
      <div class="meta">json_valid=${row.json_valid} theme_valid=${row.theme_valid} recall_hit=${row.recall_hit ?? 'n/a'}</div>
      <div>${htmlEscape(row.notes || '')}</div>
    </div>`
		)
		.join('');
	const body = `<div class="card">
  <form method="post" action="/api/eval/seed">
    <button type="submit">Seed golden dataset</button>
  </form>
  <form method="post" action="/api/eval/run">
    <button type="submit">Run Eval</button>
  </form>
</div>
${runHtml}
<h2>Failing cases</h2>
<div class="list">${failureHtml || '<div class="card">No failing cases.</div>'}</div>`;
	return htmlResponse(renderLayout('Eval', body));
}
