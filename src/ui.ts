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

type InboxStats = {
	totalFeedback: number;
	highUrgency: number;
	dupCandidates: number;
	analyzedCount: number;
	recallAt3: number | null;
};

type ThemeStat = {
	theme: string;
	count: number;
	pct: number;
};

function renderLayout(title: string, body: string): string {
	return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)}</title>
  <style>
    :root {
      --ink: #1b1f2a;
      --muted: #5c667a;
      --panel: #ffffff;
      --line: #e2e6ee;
      --accent: #f6821f;
      --accent-deep: #d96b0a;
      --blue: #3b82f6;
      --green: #12a150;
      --yellow: #c87b12;
      --red: #d62f2f;
      font-family: "Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif;
      color: var(--ink);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top, #f4f7fb 0%, #eef1f6 45%, #f7f3ee 100%);
      min-height: 100vh;
    }
    .nav {
      position: sticky;
      top: 0;
      backdrop-filter: blur(10px);
      background: rgba(255, 255, 255, 0.9);
      border-bottom: 1px solid var(--line);
      z-index: 10;
    }
    .nav-inner {
      max-width: 1120px;
      margin: 0 auto;
      padding: 0 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 64px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-mark {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--accent), var(--accent-deep));
      display: grid;
      place-items: center;
      color: #fff;
      font-weight: 700;
    }
    .brand h1 {
      font-size: 18px;
      margin: 0;
    }
    .brand p {
      font-size: 11px;
      margin: 2px 0 0;
      color: var(--muted);
    }
    .nav-links a {
      text-decoration: none;
      color: var(--muted);
      font-weight: 600;
      padding: 8px 12px;
      border-radius: 10px;
    }
    .nav-links a:hover {
      color: var(--ink);
      background: #f0f3f8;
    }
    main {
      max-width: 1120px;
      margin: 0 auto;
      padding: 28px 20px 80px;
    }
    .grid {
      display: grid;
      gap: 16px;
    }
    .grid-4 {
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    }
    .grid-3 {
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }
    .grid-2 {
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 12px 30px rgba(27, 31, 42, 0.06);
    }
    .stat-title {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin: 0 0 6px;
    }
    .stat-value {
      font-size: 28px;
      margin: 0;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: #f0f3f8;
      color: var(--muted);
    }
    .badge.theme { background: #f6eadb; color: #874f08; }
    .badge.high { background: #ffe4e2; color: var(--red); }
    .badge.medium { background: #fff1da; color: var(--yellow); }
    .badge.low { background: #e6f6eb; color: var(--green); }
    .badge.dup { background: #fff1da; color: var(--accent-deep); }
    .meta {
      font-size: 12px;
      color: var(--muted);
    }
    .title {
      font-size: 20px;
      margin: 0 0 8px;
    }
    .subtle {
      color: var(--muted);
      font-size: 13px;
    }
    input,
    textarea,
    select {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #fff;
      font: inherit;
    }
    label {
      font-size: 13px;
      font-weight: 600;
      color: var(--muted);
      display: block;
      margin-bottom: 6px;
    }
    button {
      border: none;
      border-radius: 12px;
      padding: 10px 14px;
      font-weight: 600;
      cursor: pointer;
      background: linear-gradient(135deg, var(--accent), var(--accent-deep));
      color: #fff;
    }
    button.secondary {
      background: #f0f3f8;
      color: var(--ink);
    }
    .list {
      display: grid;
      gap: 12px;
    }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      position: sticky;
      top: 0;
      background: #f7f8fb;
    }
    .card {
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 16px 32px rgba(27, 31, 42, 0.08);
    }
    .actions {
      display: grid;
      gap: 10px;
    }
    .progress {
      height: 6px;
      background: #edf1f7;
      border-radius: 999px;
      overflow: hidden;
    }
    .progress > span {
      display: block;
      height: 100%;
      background: var(--blue);
    }
  </style>
</head>
<body>
  <nav class="nav">
    <div class="nav-inner">
      <div class="brand">
        <div class="brand-mark">SD</div>
        <div>
          <h1>SignalDesk</h1>
          <p>Feedback Signal Amplifier</p>
        </div>
      </div>
      <div class="nav-links">
        <a href="/">Inbox</a>
        <a href="/themes">Themes</a>
        <a href="/results">Results</a>
        <a href="/eval">Evaluation</a>
      </div>
    </div>
  </nav>
  <main>
    ${body}
  </main>
</body>
</html>`;
}

function formatPercent(value: number | null): string {
	if (value === null || Number.isNaN(value)) return 'n/a';
	return `${Math.round(value * 100)}%`;
}

function urgencyLabel(score: number | null | undefined): { label: string; className: string } {
	if (score === null || score === undefined) return { label: 'Unknown', className: 'badge' };
	if (score >= 70) return { label: 'High urgency', className: 'badge high' };
	if (score >= 40) return { label: 'Medium urgency', className: 'badge medium' };
	return { label: 'Low urgency', className: 'badge low' };
}

async function loadInboxStats(env: Env): Promise<InboxStats> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) {
		return { totalFeedback: 0, highUrgency: 0, dupCandidates: 0, analyzedCount: 0, recallAt3: null };
	}
	const db = dbBinding.value;
	const total = await db.prepare('SELECT COUNT(*) as count FROM feedback').first();
	const high = await db.prepare('SELECT COUNT(*) as count FROM analysis WHERE urgency_score >= 70').first();
	const analyzed = await db.prepare('SELECT COUNT(*) as count FROM analysis').first();
	const dupCandidates = await db
		.prepare(
			`SELECT COUNT(*) as count FROM analysis a
       JOIN (SELECT theme FROM analysis GROUP BY theme HAVING COUNT(*) > 1) t ON a.theme = t.theme`
		)
		.first();
	const latestEval = await db.prepare('SELECT recall_at_3 FROM eval_runs ORDER BY created_at DESC LIMIT 1').first();
	return {
		totalFeedback: Number((total as any)?.count ?? 0),
		highUrgency: Number((high as any)?.count ?? 0),
		dupCandidates: Number((dupCandidates as any)?.count ?? 0),
		analyzedCount: Number((analyzed as any)?.count ?? 0),
		recallAt3: (latestEval as any)?.recall_at_3 ?? null,
	};
}

async function loadThemeStats(env: Env): Promise<{ stats: ThemeStat[]; total: number }> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return { stats: [], total: 0 };
	const db = dbBinding.value;
	const rows = await db.prepare('SELECT theme, COUNT(*) as count FROM analysis GROUP BY theme ORDER BY count DESC').all();
	const total = (rows.results || []).reduce((sum: number, row: any) => sum + Number(row.count || 0), 0);
	const stats = (rows.results || []).map((row: any) => ({
		theme: row.theme,
		count: Number(row.count || 0),
		pct: total ? Number(row.count || 0) / total : 0,
	}));
	return { stats, total };
}

export async function renderInbox(env: Env): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return htmlResponse(renderLayout('Inbox', `<div class="panel">Missing DB binding.</div>`), 500);
	const items = await listRecentFeedback(dbBinding.value);
	const stats = await loadInboxStats(env);
	const listItems = items
		.map((item) => {
			const themeBadge = item.theme ? `<span class="badge theme">${htmlEscape(item.theme)}</span>` : '';
			const urgency = urgencyLabel(item.urgency_score);
			const sentiment = item.sentiment_label ? `<span class="badge">${htmlEscape(item.sentiment_label)}</span>` : '';
			return `<div class="card">
        <div class="meta">${htmlEscape(item.source)} · ${htmlEscape(item.created_at)}</div>
        <h3 class="title">${htmlEscape(item.title || 'Untitled')}</h3>
        <p class="subtle">${htmlEscape(item.body.slice(0, 220))}${item.body.length > 220 ? '…' : ''}</p>
        <div style="margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px;">
          ${themeBadge}
          <span class="${urgency.className}">${urgency.label}</span>
          ${sentiment}
        </div>
        <div style="margin-top: 10px;">
          <a href="/feedback?id=${encodeURIComponent(item.id)}">View details</a>
        </div>
      </div>`;
		})
		.join('');
	const body = `<section class="grid grid-4">
  <div class="panel">
    <p class="stat-title">Total Feedback</p>
    <p class="stat-value">${stats.totalFeedback}</p>
    <p class="subtle">${stats.analyzedCount} analyzed</p>
  </div>
  <div class="panel">
    <p class="stat-title">High Urgency</p>
    <p class="stat-value" style="color: var(--red)">${stats.highUrgency}</p>
    <p class="subtle">urgency ≥ 70</p>
  </div>
  <div class="panel">
    <p class="stat-title">Potential Duplicates</p>
    <p class="stat-value" style="color: var(--accent)">${stats.dupCandidates}</p>
    <p class="subtle">themes with multiple reports</p>
  </div>
  <div class="panel">
    <p class="stat-title">Recall@3</p>
    <p class="stat-value" style="color: var(--green)">${formatPercent(stats.recallAt3)}</p>
    <p class="subtle">latest evaluation</p>
  </div>
</section>

<section class="grid" style="margin-top: 22px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));">
  <div class="panel">
    <h2 class="title">Submit Feedback</h2>
    <form method="post" action="/api/feedback">
      <label>Source</label>
      <select name="source">
        ${ALLOWED_SOURCES.filter((s) => s !== 'golden').map((source) => `<option value="${source}">${source}</option>`).join('')}
      </select>
      <label>Title</label>
      <input name="title" maxlength="${MAX_TITLE_CHARS}" />
      <label>Body</label>
      <textarea name="body" rows="5" maxlength="${MAX_BODY_CHARS}"></textarea>
      <label>Customer Tier</label>
      <input name="customer_tier" maxlength="${MAX_TIER_CHARS}" />
      <button type="submit">Analyze feedback</button>
    </form>
    <div style="margin-top: 18px;">
      <h3 class="subtle" style="font-weight: 700;">Quick actions</h3>
      <div class="actions">
        <form method="post" action="/api/feedback/bulk?analyze=1">
          <button type="submit" class="secondary">Import messy dataset</button>
        </form>
        <form method="post" action="/api/eval/run">
          <button type="submit" class="secondary">Run evaluation</button>
        </form>
      </div>
    </div>
  </div>
  <div style="grid-column: span 2;">
    <div class="panel">
      <h2 class="title">Recent Feedback</h2>
      <div class="list">${listItems || '<div class="card">No feedback yet.</div>'}</div>
    </div>
  </div>
</section>`;
	return htmlResponse(renderLayout('Inbox', body));
}

export async function renderThemes(env: Env): Promise<Response> {
	const { stats, total } = await loadThemeStats(env);
	const themeCards = stats
		.map((row) => {
			const pct = Math.round(row.pct * 100);
			return `<div class="panel">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span class="badge theme">${htmlEscape(row.theme)}</span>
          <strong>${row.count}</strong>
        </div>
        <div class="progress" style="margin: 12px 0 8px;">
          <span style="width: ${pct}%;"></span>
        </div>
        <div class="subtle">${pct}% of analyzed feedback</div>
      </div>`;
		})
		.join('');
	const body = `<h2 class="title">Theme Distribution</h2>
<p class="subtle">${total} analyzed items</p>
<div class="grid grid-3" style="margin-top: 16px;">${themeCards || '<div class="panel">No themes yet.</div>'}</div>`;
	return htmlResponse(renderLayout('Themes', body));
}

export async function renderFeedbackDetail(env: Env, id: string): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return htmlResponse(renderLayout('Feedback', `<div class="panel">Missing DB binding.</div>`), 500);
	const db = dbBinding.value;
	const feedback = await fetchFeedbackById(db, id);
	if (!feedback) return htmlResponse(renderLayout('Feedback', `<div class="panel">Not found.</div>`), 404);
	const analysis = (await db.prepare('SELECT * FROM analysis WHERE feedback_id = ?').bind(id).first()) as AnalysisRow | null;
	let similarHtml = '<div class="panel">Vector search not configured.</div>';
	if (env.VEC) {
		const similar = await searchSimilar(env, feedback, 3);
		if (similar.items.length === 0) {
			similarHtml = '<div class="panel">No similar feedback found.</div>';
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
	const urgency = urgencyLabel(analysis?.urgency_score);
	const analysisHtml = analysis
		? `<div class="panel">
      <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px;">
        <span class="badge theme">${htmlEscape(analysis.theme)}</span>
        <span class="${urgency.className}">${urgency.label}</span>
        <span class="badge">${htmlEscape(analysis.sentiment_label)}</span>
      </div>
      <p><strong>Summary:</strong> ${htmlEscape(analysis.summary)}</p>
      <p><strong>Urgency:</strong> ${analysis.urgency_score} (${htmlEscape(analysis.severity)})</p>
      <p><strong>Suggested owner:</strong> ${htmlEscape(analysis.suggested_owner)}</p>
      <p><strong>Proposed fix:</strong> ${htmlEscape(analysis.proposed_fix)}</p>
    </div>`
		: `<div class="panel">No analysis yet. <form method="post" action="/api/feedback/${encodeURIComponent(id)}/analyze"><button type="submit">Analyze</button></form></div>`;
	const body = `<div class="grid grid-2">
  <div>
    <div class="panel">
      <div class="meta">${htmlEscape(feedback.source)} · ${htmlEscape(feedback.created_at)}</div>
      <h2 class="title">${htmlEscape(feedback.title || 'Untitled')}</h2>
      <p>${htmlEscape(feedback.body)}</p>
      <p class="subtle">Tier: ${htmlEscape(feedback.customer_tier || 'n/a')}</p>
    </div>
    <h3 class="title" style="margin-top: 20px;">Analysis</h3>
    ${analysisHtml}
  </div>
  <div>
    <h3 class="title">Similar</h3>
    ${similarHtml}
  </div>
</div>`;
	return htmlResponse(renderLayout('Feedback', body));
}

export async function renderEval(env: Env): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return htmlResponse(renderLayout('Eval', `<div class="panel">Missing DB binding.</div>`), 500);
	const db = dbBinding.value;
	const latest = (await db.prepare('SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT 1').first()) as any;
	const failures = await db
		.prepare('SELECT * FROM eval_cases WHERE json_valid = 0 OR theme_valid = 0 OR recall_hit = 0 ORDER BY rowid DESC LIMIT 10')
		.all();
	const jsonValid = latest?.json_valid_rate ?? null;
	const themeValid = latest?.theme_valid_rate ?? null;
	const recallAt3 = latest?.recall_at_3 ?? null;
	const failureHtml = (failures.results || [])
		.map(
			(row: any) => `<div class="card">
      <div><strong>${htmlEscape(row.feedback_id)}</strong></div>
      <div class="meta">json_valid=${row.json_valid} theme_valid=${row.theme_valid} recall_hit=${row.recall_hit ?? 'n/a'}</div>
      <div>${htmlEscape(row.notes || '')}</div>
    </div>`
		)
		.join('');
	const body = `<h2 class="title">System Evaluation</h2>
<div class="grid grid-2" style="margin-top: 16px;">
  <div class="panel">
    <h3 class="title">Latest run</h3>
    <div class="grid" style="gap: 12px;">
      <div class="panel" style="border-color: #dfe7f3;">
        <div class="meta">JSON valid rate</div>
        <div class="stat-value" style="color: var(--green)">${formatPercent(jsonValid)}</div>
      </div>
      <div class="panel" style="border-color: #dfe7f3;">
        <div class="meta">Theme valid rate</div>
        <div class="stat-value" style="color: var(--green)">${formatPercent(themeValid)}</div>
      </div>
      <div class="panel" style="border-color: #f5e7d0;">
        <div class="meta">Recall@3</div>
        <div class="stat-value" style="color: var(--yellow)">${formatPercent(recallAt3)}</div>
      </div>
    </div>
    <form method="post" action="/api/eval/run" style="margin-top: 16px;">
      <button type="submit">Run new evaluation</button>
    </form>
  </div>
  <div class="panel">
    <h3 class="title">Failing cases</h3>
    <div class="list">${failureHtml || '<div class="card">All cases passing.</div>'}</div>
  </div>
</div>`;
	return htmlResponse(renderLayout('Eval', body));
}

async function loadAnalysisRows(env: Env): Promise<any[]> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return [];
	const db = dbBinding.value;
	const rows = await db
		.prepare(
			`SELECT f.id, f.source, f.title, f.customer_tier, f.created_at,
       a.theme, a.sentiment_label, a.urgency_score, a.suggested_owner, a.summary
       FROM feedback f
       LEFT JOIN analysis a ON f.id = a.feedback_id
       ORDER BY f.created_at DESC
       LIMIT 200`
		)
		.all();
	return rows.results || [];
}

export async function renderResults(env: Env): Promise<Response> {
	const rows = await loadAnalysisRows(env);
	const tableRows = rows
		.map((row: any) => {
			const urgency = urgencyLabel(row.urgency_score);
			return `<tr>
        <td><a href="/feedback?id=${encodeURIComponent(row.id)}">${htmlEscape(row.id)}</a></td>
        <td>${htmlEscape(row.source || '')}</td>
        <td>${htmlEscape(row.title || 'Untitled')}</td>
        <td>${htmlEscape(row.customer_tier || 'n/a')}</td>
        <td>${htmlEscape(row.theme || 'n/a')}</td>
        <td>${htmlEscape(row.sentiment_label || 'n/a')}</td>
        <td><span class="${urgency.className}">${urgency.label}</span></td>
        <td>${row.urgency_score ?? 'n/a'}</td>
        <td>${htmlEscape(row.suggested_owner || 'n/a')}</td>
        <td>${htmlEscape(row.summary || '')}</td>
        <td>${htmlEscape(row.created_at || '')}</td>
      </tr>`;
		})
		.join('');
	const body = `<h2 class="title">AI Results Sheet</h2>
<p class="subtle">Latest 200 items with AI analysis.</p>
<div class="panel" style="margin-top: 16px;">
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Source</th>
          <th>Title</th>
          <th>Tier</th>
          <th>Theme</th>
          <th>Sentiment</th>
          <th>Urgency</th>
          <th>Score</th>
          <th>Owner</th>
          <th>Summary</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows || '<tr><td colspan="11">No analysis yet.</td></tr>'}
      </tbody>
    </table>
  </div>
</div>`;
	return htmlResponse(renderLayout('Results', body));
}

export function renderMessagePage(title: string, message: string, status = 400): Response {
	const body = `<div class="panel">${htmlEscape(message)}</div>`;
	return htmlResponse(renderLayout(title, body), status);
}
