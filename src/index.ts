const MAX_BODY_BYTES = 20000;
const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 8000;
const MAX_TIER_CHARS = 50;
const THEME_TAXONOMY = [
	'Docs confusion',
	'Billing/pricing',
	'Performance/latency',
	'Reliability/outage',
	'Authentication/access',
	'Dashboard UX',
	'API ergonomics',
	'Limits/quotas',
	'Feature request',
] as const;
const ALLOWED_SOURCES = [
	'app',
	'email',
	'slack',
	'intercom',
	'web',
	'api',
	'golden',
	'discord',
	'twitter',
	'github',
	'github issue',
	'community forum',
	'salesforce',
	'salesforce note',
	'hacker news',
	'zendesk',
	'stackoverflow',
	'stack overflow',
	'reddit',
	'g2 crowd',
	'spambot',
] as const;
const ANALYSIS_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const PROMPT_VERSION = 'v1';

type Theme = (typeof THEME_TAXONOMY)[number];

type FeedbackRow = {
	id: string;
	source: string;
	title: string | null;
	body: string;
	customer_tier: string | null;
	created_at: string;
};

type AnalysisRow = {
	feedback_id: string;
	summary: string;
	theme: string;
	sentiment_label: string;
	sentiment_score: number;
	urgency_score: number;
	severity: string;
	suggested_owner: string;
	proposed_fix: string;
	analyzed_at: string;
	model: string;
};

type Env = {
	DB?: D1Database;
	AI?: any;
	VEC?: any;
};

function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			...headers,
		},
	});
}

function htmlResponse(html: string, status = 200): Response {
	return new Response(html, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
		},
	});
}

function errorResponse(message: string, status = 400, extras?: Record<string, unknown>): Response {
	return jsonResponse({ error: message, ...extras }, status);
}

function htmlEscape(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

async function parseJSON(request: Request, maxBytes = MAX_BODY_BYTES): Promise<{ value?: any; error?: Response }> {
	const text = await request.text();
	if (text.length > maxBytes) {
		return { error: errorResponse('Request body too large', 413) };
	}
	try {
		return { value: JSON.parse(text) };
	} catch (err) {
		return { error: errorResponse('Invalid JSON', 400) };
	}
}

async function parseJSONOptional(
	request: Request,
	maxBytes = MAX_BODY_BYTES
): Promise<{ value?: any; error?: Response; empty?: boolean }> {
	const text = await request.text();
	if (!text.trim()) {
		return { empty: true };
	}
	if (text.length > maxBytes) {
		return { error: errorResponse('Request body too large', 413) };
	}
	try {
		return { value: JSON.parse(text) };
	} catch (err) {
		return { error: errorResponse('Invalid JSON', 400) };
	}
}

function requireBinding<T>(binding: T | undefined, name: string): { value?: T; error?: Response } {
	if (!binding) {
		return { error: errorResponse(`Missing binding: ${name}`, 500) };
	}
	return { value: binding };
}

function nowIso(): string {
	return new Date().toISOString();
}

function toSeverity(urgencyScore: number): string {
	if (urgencyScore >= 70) return 'high';
	if (urgencyScore >= 40) return 'medium';
	return 'low';
}

function themeIsValid(theme: string): theme is Theme {
	return THEME_TAXONOMY.includes(theme as Theme);
}

function normalizeText(value: string | null | undefined): string {
	return value ? value.trim() : '';
}

function normalizeSource(value: unknown): string {
	if (typeof value !== 'string') return '';
	return value.trim().toLowerCase().replace(/\\s+/g, ' ');
}

async function parseFeedbackPayload(request: Request): Promise<{ value?: any; error?: Response; isForm?: boolean }> {
	const contentType = request.headers.get('content-type') || '';
	if (contentType.includes('application/json')) {
		const parsed = await parseJSON(request);
		return { ...parsed, isForm: false };
	}
	try {
		const form = await request.formData();
		const payload = {
			source: form.get('source'),
			title: form.get('title'),
			body: form.get('body'),
			customer_tier: form.get('customer_tier'),
		};
		return { value: payload, isForm: true };
	} catch (err) {
		return { error: errorResponse('Unsupported form body', 400) };
	}
}

function validateFeedbackInput(input: any): { value?: { source: string; title?: string; body: string; customer_tier?: string }; error?: Response } {
	const source = normalizeSource(input?.source);
	if (!ALLOWED_SOURCES.includes(source as (typeof ALLOWED_SOURCES)[number])) {
		return { error: errorResponse(`Invalid source. Allowed: ${ALLOWED_SOURCES.join(', ')}`, 400) };
	}
	const title = normalizeText(typeof input?.title === 'string' ? input.title : '');
	const body = normalizeText(typeof input?.body === 'string' ? input.body : '');
	const customerTier = normalizeText(typeof input?.customer_tier === 'string' ? input.customer_tier : '');
	if (!body) {
		return { error: errorResponse('Body is required', 400) };
	}
	if (body.length > MAX_BODY_CHARS) {
		return { error: errorResponse(`Body too long (max ${MAX_BODY_CHARS} chars)`, 400) };
	}
	if (title.length > MAX_TITLE_CHARS) {
		return { error: errorResponse(`Title too long (max ${MAX_TITLE_CHARS} chars)`, 400) };
	}
	if (customerTier.length > MAX_TIER_CHARS) {
		return { error: errorResponse(`Customer tier too long (max ${MAX_TIER_CHARS} chars)`, 400) };
	}
	return {
		value: {
			source,
			title: title || undefined,
			body,
			customer_tier: customerTier || undefined,
		},
	};
}

function extractAiText(aiResult: any): string {
	if (typeof aiResult === 'string') return aiResult;
	if (aiResult?.response && typeof aiResult.response === 'string') return aiResult.response;
	if (aiResult?.result && typeof aiResult.result === 'string') return aiResult.result;
	if (aiResult?.text && typeof aiResult.text === 'string') return aiResult.text;
	return JSON.stringify(aiResult ?? {});
}

function validateAnalysisPayload(payload: any): { value?: any; error?: string } {
	if (!payload || typeof payload !== 'object') return { error: 'Response is not a JSON object' };
	const required = [
		'summary',
		'theme',
		'sentiment_label',
		'sentiment_score',
		'urgency_score',
		'proposed_fix',
		'suggested_owner',
	] as const;
	for (const key of required) {
		if (!(key in payload)) return { error: `Missing key: ${key}` };
	}
	if (typeof payload.summary !== 'string' || !payload.summary.trim()) return { error: 'Invalid summary' };
	if (typeof payload.theme !== 'string' || !themeIsValid(payload.theme)) return { error: 'Invalid theme' };
	if (typeof payload.sentiment_label !== 'string' || !payload.sentiment_label.trim()) return { error: 'Invalid sentiment_label' };
	const sentimentScore = Number(payload.sentiment_score);
	if (!Number.isFinite(sentimentScore) || sentimentScore < 0 || sentimentScore > 1) return { error: 'Invalid sentiment_score' };
	const urgencyScore = Number(payload.urgency_score);
	if (!Number.isFinite(urgencyScore) || urgencyScore < 0 || urgencyScore > 100) return { error: 'Invalid urgency_score' };
	if (typeof payload.proposed_fix !== 'string') return { error: 'Invalid proposed_fix' };
	if (typeof payload.suggested_owner !== 'string') return { error: 'Invalid suggested_owner' };
	return {
		value: {
			summary: payload.summary.trim(),
			theme: payload.theme,
			sentiment_label: payload.sentiment_label.trim(),
			sentiment_score: sentimentScore,
			urgency_score: Math.round(urgencyScore),
			proposed_fix: payload.proposed_fix.trim(),
			suggested_owner: payload.suggested_owner.trim(),
		},
	};
}

async function runAiAnalysis(env: Env, feedback: FeedbackRow): Promise<{ analysis?: any; error?: string; raw?: string }> {
	const aiBinding = requireBinding(env.AI, 'AI');
	if (aiBinding.error) return { error: 'Missing binding: AI' };

	// Enhanced system prompt with role definition and constraints
	const systemPrompt = `You are a Product Manager feedback analyzer for Cloudflare's developer platform.

Your task: Analyze customer feedback and extract structured insights to help PMs prioritize issues.

OUTPUT FORMAT: Respond ONLY with a valid JSON object. No markdown, no explanations, no extra text.

Required JSON structure:
{
  "summary": "1-2 sentence summary of the core issue",
  "theme": "exactly one of: ${THEME_TAXONOMY.join(', ')}",
  "sentiment_label": "positive, negative, or neutral",
  "sentiment_score": 0.0-1.0 (0=very negative, 1=very positive),
  "urgency_score": 0-100 (0=low, 100=critical/blocking),
  "proposed_fix": "actionable next step or solution",
  "suggested_owner": "team that should own this (e.g., Docs, Engineering, Dashboard, API)"
}

THEME GUIDELINES:
- "Docs confusion": unclear documentation, missing examples, contradictory guides
- "Billing/pricing": unexpected charges, pricing questions, invoice issues
- "Performance/latency": slow responses, timeouts, replication lag
- "Reliability/outage": 5xx errors, service down, failed deployments
- "Authentication/access": login issues, SSO problems, permission errors
- "Dashboard UX": navigation problems, UI bugs, missing features in dashboard
- "API ergonomics": API design issues, SDK problems, CLI bugs
- "Limits/quotas": hitting rate limits, size limits, or resource constraints
- "Feature request": requests for new capabilities

URGENCY SCORING:
- 90-100: Production outage, data loss, security issue, blocking Enterprise customer
- 70-89: Significant impact on workflow, affecting multiple users, recurring issue
- 40-69: Moderate inconvenience, workaround exists, single user affected
- 0-39: Nice to have, cosmetic issue, positive feedback

IMPORTANT: Choose the theme that best matches the PRIMARY issue, not secondary mentions.`;

	// Enhanced user prompt with examples
	const userPrompt = `Analyze this customer feedback:

SOURCE: ${feedback.source}
CUSTOMER TIER: ${feedback.customer_tier || 'Unknown'}
TITLE: ${feedback.title || 'No title'}

FEEDBACK BODY:
${feedback.body}

Remember: Output ONLY the JSON object with all required fields. No additional text.`;

	let rawText = '';
	try {
		const aiResult = await aiBinding.value.run(ANALYSIS_MODEL, {
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt },
			],
			temperature: 0.1, // Lower for more consistent outputs
			max_tokens: 500, // Increased slightly for longer responses
		});
		rawText = extractAiText(aiResult);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'AI request failed';
		return { error: message };
	}

	// Clean up common LLM artifacts before parsing
	let cleanedText = rawText.trim();
	
	// Remove markdown code fences if present
	cleanedText = cleanedText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
	
	// Remove any leading/trailing text outside JSON
	const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		cleanedText = jsonMatch[0];
	}

	try {
		const parsed = JSON.parse(cleanedText);
		const validated = validateAnalysisPayload(parsed);
		if (validated.value) return { analysis: validated.value, raw: rawText };
		return { error: validated.error || 'Invalid analysis payload', raw: rawText };
	} catch (err) {
		return { error: 'Invalid JSON from AI', raw: rawText };
	}
}

async function runAiAnalysisWithRetry(env: Env, feedback: FeedbackRow): Promise<{ analysis?: any; error?: string; raw?: string }> {
	let result = await runAiAnalysis(env, feedback);
	if (result.analysis) return result;

	const aiBinding = requireBinding(env.AI, 'AI');
	if (aiBinding.error) return { error: 'Missing binding: AI' };

	// More specific retry prompt with error feedback
	const fixPrompt = `Your previous response was invalid. Here's what went wrong and what you need to fix:

PREVIOUS ATTEMPT:
${result.raw || ''}

ERROR: ${result.error || 'Invalid JSON structure'}

Please provide ONLY a valid JSON object with these exact fields:
- summary (string)
- theme (one of: ${THEME_TAXONOMY.join(', ')})
- sentiment_label (string)
- sentiment_score (number between 0 and 1)
- urgency_score (integer between 0 and 100)
- proposed_fix (string)
- suggested_owner (string)

Original feedback context:
Source: ${feedback.source}
Title: ${feedback.title || 'No title'}
Body: ${feedback.body.substring(0, 200)}...

Output ONLY the corrected JSON. No explanations.`;

	let rawText = '';
	try {
		const aiResult = await aiBinding.value.run(ANALYSIS_MODEL, {
			messages: [
				{ role: 'system', content: 'You are a JSON generator. Output only valid JSON, nothing else.' },
				{ role: 'user', content: fixPrompt },
			],
			temperature: 0.05, // Even lower for retry
			max_tokens: 500,
		});
		rawText = extractAiText(aiResult);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'AI request failed';
		return { error: message };
	}

	// Same cleanup as above
	let cleanedText = rawText.trim();
	cleanedText = cleanedText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
	const jsonMatch = cleanedText.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		cleanedText = jsonMatch[0];
	}

	try {
		const parsed = JSON.parse(cleanedText);
		const validated = validateAnalysisPayload(parsed);
		if (validated.value) return { analysis: validated.value, raw: rawText };
		return { error: validated.error || 'Invalid analysis payload', raw: rawText };
	} catch (err) {
		return { error: 'Invalid JSON from AI after retry', raw: rawText };
	}
}

async function embedText(env: Env, text: string): Promise<{ vector?: number[]; error?: string }> {
	const aiBinding = requireBinding(env.AI, 'AI');
	if (aiBinding.error) return { error: 'Missing binding: AI' };
	const aiResult = await aiBinding.value.run(EMBED_MODEL, { text: [text] });
	const data = aiResult?.data ?? aiResult?.result ?? aiResult;
	if (Array.isArray(data) && Array.isArray(data[0])) {
		return { vector: data[0] };
	}
	if (Array.isArray(data)) {
		return { vector: data as number[] };
	}
	return { error: 'Embedding unavailable' };
}

async function upsertVector(env: Env, feedback: FeedbackRow, analysis: any): Promise<void> {
	if (!env.VEC) return;
	const embedding = await embedText(env, `${feedback.title || ''}\n${feedback.body}`);
	if (!embedding.vector) return;
	await env.VEC.upsert([
		{
			id: feedback.id,
			values: embedding.vector,
			metadata: {
				theme: analysis.theme,
				source: feedback.source,
				created_at: feedback.created_at,
			},
		},
	]);
}

async function analyzeAndStore(env: Env, feedback: FeedbackRow): Promise<{ analysis?: AnalysisRow; error?: Response }> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return { error: dbBinding.error };
	const aiResult = await runAiAnalysisWithRetry(env, feedback);
	if (!aiResult.analysis) {
		const status = aiResult.error?.startsWith('Missing binding') ? 500 : 502;
		return { error: errorResponse(`AI analysis failed: ${aiResult.error}`, status) };
	}
	const analyzedAt = nowIso();
	const analysisRow: AnalysisRow = {
		feedback_id: feedback.id,
		summary: aiResult.analysis.summary,
		theme: aiResult.analysis.theme,
		sentiment_label: aiResult.analysis.sentiment_label,
		sentiment_score: aiResult.analysis.sentiment_score,
		urgency_score: aiResult.analysis.urgency_score,
		severity: toSeverity(aiResult.analysis.urgency_score),
		suggested_owner: aiResult.analysis.suggested_owner,
		proposed_fix: aiResult.analysis.proposed_fix,
		analyzed_at: analyzedAt,
		model: ANALYSIS_MODEL,
	};
	await dbBinding.value
		.prepare(
			`INSERT INTO analysis (feedback_id, summary, theme, sentiment_label, sentiment_score, urgency_score, severity, suggested_owner, proposed_fix, analyzed_at, model)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(feedback_id) DO UPDATE SET
			 summary = excluded.summary,
			 theme = excluded.theme,
			 sentiment_label = excluded.sentiment_label,
			 sentiment_score = excluded.sentiment_score,
			 urgency_score = excluded.urgency_score,
			 severity = excluded.severity,
			 suggested_owner = excluded.suggested_owner,
			 proposed_fix = excluded.proposed_fix,
			 analyzed_at = excluded.analyzed_at,
			 model = excluded.model`
		)
		.bind(
			analysisRow.feedback_id,
			analysisRow.summary,
			analysisRow.theme,
			analysisRow.sentiment_label,
			analysisRow.sentiment_score,
			analysisRow.urgency_score,
			analysisRow.severity,
			analysisRow.suggested_owner,
			analysisRow.proposed_fix,
			analysisRow.analyzed_at,
			analysisRow.model
		)
		.run();
	await upsertVector(env, feedback, analysisRow);
	return { analysis: analysisRow };
}

async function fetchFeedbackById(db: D1Database, id: string): Promise<FeedbackRow | null> {
	const result = await db.prepare('SELECT * FROM feedback WHERE id = ?').bind(id).first();
	return (result as FeedbackRow) || null;
}

async function listRecentFeedback(db: D1Database): Promise<any[]> {
	const result = await db
		.prepare(
			`SELECT f.id, f.source, f.title, f.body, f.customer_tier, f.created_at,
			 a.summary, a.theme, a.sentiment_label, a.sentiment_score, a.urgency_score, a.severity, a.suggested_owner
			 FROM feedback f
			 LEFT JOIN analysis a ON f.id = a.feedback_id
			 ORDER BY f.created_at DESC
			 LIMIT 20`
		)
		.all();
	return result.results || [];
}

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
      margin-right: 8px;
    }
    label {
      display: block;
      font-weight: 600;
      margin-top: 10px;
    }
    input, textarea, select, button {
      width: 100%;
      font-size: 14px;
      padding: 8px;
      border-radius: 8px;
      border: 1px solid #c9c1b3;
      margin-top: 6px;
      box-sizing: border-box;
    }
    button {
      background: #28324a;
      color: #fff;
      border: none;
      cursor: pointer;
      margin-top: 12px;
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

async function renderInbox(env: Env): Promise<Response> {
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

async function renderThemes(env: Env): Promise<Response> {
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

async function renderFeedbackDetail(env: Env, id: string): Promise<Response> {
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

async function renderEval(env: Env): Promise<Response> {
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

type SearchResult = { id: string; title: string | null; theme: string | null };

async function searchSimilar(env: Env, feedback: FeedbackRow, limit = 5): Promise<{ items: SearchResult[]; note?: string }> {
	if (!env.VEC) return { items: [], note: 'Vectorize not configured' };
	const embedding = await embedText(env, `${feedback.title || ''}\n${feedback.body}`);
	if (!embedding.vector) return { items: [], note: 'Embedding failed' };
	const vecResult = await env.VEC.query(embedding.vector, { topK: limit + 1, returnMetadata: true });
	const matches = vecResult?.matches || vecResult?.result || [];
	const ids = matches.map((match: any) => match.id).filter((id: string) => id && id !== feedback.id);
	if (ids.length === 0) return { items: [] };
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return { items: [] };
	const placeholders = ids.map(() => '?').join(', ');
	const rows = await dbBinding.value
		.prepare(
			`SELECT f.id, f.title, a.theme
       FROM feedback f
       LEFT JOIN analysis a ON f.id = a.feedback_id
       WHERE f.id IN (${placeholders})`
		)
		.bind(...ids)
		.all();
	const rowMap = new Map((rows.results || []).map((row: any) => [row.id, row]));
	const ordered = ids
		.map((id: string) => rowMap.get(id))
		.filter(Boolean)
		.map((row: any) => ({ id: row.id, title: row.title, theme: row.theme }))
		.slice(0, limit);
	return { items: ordered };
}

const GOLDEN_SET: Array<{
	id: string;
	source: string;
	title: string | null;
	body: string;
	customer_tier?: string | null;
	created_at?: string;
}> = [
	{
		id: 'gold_01',
		created_at: '2025-10-01T08:30:00Z',
		source: 'Discord',
		title: 'Wrangler tail blank',
		body: "I'm running 'wrangler tail' on my worker but the console is staying completely blank even though requests are hitting the endpoint. Is there a delay?",
		customer_tier: 'Pro',
	},
	{
		id: 'gold_02',
		created_at: '2025-10-01T09:15:00Z',
		source: 'GitHub Issue',
		title: 'CLI logs empty',
		body: 'Bug report: Real-time logging seems broken. I execute the tail command and get zero output stream. Validated traffic is active.',
		customer_tier: 'Free',
	},
	{
		id: 'gold_03',
		created_at: '2025-10-02T14:20:00Z',
		source: 'Zendesk',
		title: 'Unexpected $50 charge',
		body: 'I thought Workers KV was included in the bundled plan? Why am I seeing an overage charge for read operations on my invoice this month?',
		customer_tier: 'Business',
	},
	{
		id: 'gold_04',
		created_at: '2025-10-02T16:45:00Z',
		source: 'Twitter',
		title: null,
		body: "@CloudflareHelp hey, billing discrepancy here. I'm being billed for KV reads that should be under the free tier limit. Can someone explain the pricing model again?",
		customer_tier: 'Pro',
	},
	{
		id: 'gold_05',
		created_at: '2025-10-03T04:10:00Z',
		source: 'Discord',
		title: 'D1 replication lag in APAC',
		body: 'Seeing massive consistency issues when writing to D1 in output and reading in Singapore. The replication seems stuck.',
		customer_tier: 'Enterprise',
	},
	{
		id: 'gold_06',
		created_at: '2025-10-03T05:00:00Z',
		source: 'Community Forum',
		title: 'Database sync slow',
		body: "My users in Asia are getting old data. It looks like the primary D1 isn't pushing updates to the read replicas fast enough.",
		customer_tier: 'Pro',
	},
	{
		id: 'gold_07',
		created_at: '2025-10-04T11:00:00Z',
		source: 'GitHub Issue',
		title: 'Docs: bindings vs env vars',
		body: 'The documentation for setting up environment variables in wrangler.toml is confusing. It contradicts the page on bindings.',
		customer_tier: 'Free',
	},
	{
		id: 'gold_08',
		created_at: '2025-10-04T13:30:00Z',
		source: 'Discord',
		title: 'Config confusion',
		body: "I followed the guide for 'vars' but it says 'bindings' elsewhere. The examples in the docs don't match the current schema.",
		customer_tier: 'Free',
	},
	{
		id: 'gold_09',
		created_at: '2025-10-05T09:20:00Z',
		source: 'Zendesk',
		title: "Can't login to dash",
		body: "I'm stuck in a redirect loop when I try to access the Cloudflare dashboard via SSO. It keeps sending me back to the identity provider.",
		customer_tier: 'Enterprise',
	},
	{
		id: 'gold_10',
		created_at: '2025-10-05T10:05:00Z',
		source: 'Email',
		title: 'SSO Failure',
		body: 'Urgent: Our team cannot access the account. The SAML handshake completes but then we get bounced back to the login screen.',
		customer_tier: 'Enterprise',
	},
	{
		id: 'gold_11',
		created_at: '2025-10-06T15:00:00Z',
		source: 'StackOverflow',
		title: '502 on Origin',
		body: 'I keep getting 502 Bad Gateway errors when my Worker tries to fetch from my AWS origin. It works locally. Is this a known issue?',
		customer_tier: 'Pro',
	},
	{
		id: 'gold_12',
		created_at: '2025-10-06T15:45:00Z',
		source: 'Discord',
		title: 'Fetch failures',
		body: 'My worker is throwing 502s communicating with the backend. Did something change in the outbound networking?',
		customer_tier: 'Business',
	},
	{
		id: 'gold_13',
		created_at: '2025-10-07T10:00:00Z',
		source: 'GitHub Issue',
		title: 'Feature: Python Support',
		body: 'We need native Python support in Workers. Using WASM is too heavy for our simple data processing scripts.',
		customer_tier: 'Enterprise',
	},
	{
		id: 'gold_14',
		created_at: '2025-10-07T14:20:00Z',
		source: 'Salesforce Note',
		title: 'Python Requirement',
		body: 'Customer is blocking adoption because their data science team only writes Python. They want to run inference at the edge.',
		customer_tier: 'Enterprise',
	},
	{
		id: 'gold_15',
		created_at: '2025-10-08T09:00:00Z',
		source: 'Discord',
		title: 'Wrangler login browser issue',
		body: 'When I type wrangler login, it opens the browser but never redirects back to the terminal. It just hangs.',
		customer_tier: 'Free',
	},
	{
		id: 'gold_16',
		created_at: '2025-10-08T11:15:00Z',
		source: 'GitHub Issue',
		title: 'Auth callback hang',
		body: "Wrangler 3.0.0 hangs on 'Waiting for API token' after I successfully click allow in Chrome. Windows 11.",
		customer_tier: 'Free',
	},
	{
		id: 'gold_17',
		created_at: '2025-10-09T13:40:00Z',
		source: 'Zendesk',
		title: 'CPU Limit 10ms',
		body: "My worker is hitting the 10ms CPU limit but the profiler says I'm only using 3ms. Is the calculation including wait time?",
		customer_tier: 'Business',
	},
	{
		id: 'gold_18',
		created_at: '2025-10-09T16:00:00Z',
		source: 'Community Forum',
		title: 'Exceeded CPU Limit',
		body: "I'm getting error 1102 (CPU Limit Exceeded) on a very simple worker. Does IO wait time count against the CPU budget?",
		customer_tier: 'Pro',
	},
	{
		id: 'gold_19',
		created_at: '2025-10-10T10:00:00Z',
		source: 'Twitter',
		title: null,
		body: "The new nav bar in the dashboard is terrible. I can't find the DNS settings anymore.",
		customer_tier: 'Unknown',
	},
	{
		id: 'gold_20',
		created_at: '2025-10-10T12:30:00Z',
		source: 'Reddit',
		title: 'UI Update sucks',
		body: 'Why did they move the DNS tab? It takes me 4 clicks to get where it used to take 1. Bad UX.',
		customer_tier: 'Free',
	},
	{
		id: 'gold_21',
		created_at: '2025-10-11T09:00:00Z',
		source: 'Discord',
		title: 'R2 presigned URLs',
		body: "Does R2 support presigned URLs for uploads yet? I can't find it in the docs.",
		customer_tier: 'Pro',
	},
	{
		id: 'gold_22',
		created_at: '2025-10-11T14:00:00Z',
		source: 'Zendesk',
		title: 'D1 Backup Restore',
		body: 'I accidentally deleted a table. Is there a way to restore D1 from a snapshot from yesterday?',
		customer_tier: 'Business',
	},
	{
		id: 'gold_23',
		created_at: '2025-10-12T08:00:00Z',
		source: 'GitHub Issue',
		title: 'Wrangler dev memory leak',
		body: "Wrangler dev seems to consume more RAM the longer I leave it running. After 2 hours it's using 4GB.",
		customer_tier: 'Pro',
	},
	{
		id: 'gold_24',
		created_at: '2025-10-12T11:00:00Z',
		source: 'Community Forum',
		title: 'Pages build stuck',
		body: "My pages build has been stuck on 'Initializing build environment' for 45 minutes.",
		customer_tier: 'Free',
	},
	{
		id: 'gold_25',
		created_at: '2025-10-13T10:30:00Z',
		source: 'Discord',
		title: 'KV list keys slow',
		body: 'Listing keys in KV is taking 5+ seconds. Is this normal latency for a list operation?',
		customer_tier: 'Enterprise',
	},
	{
		id: 'gold_26',
		created_at: '2025-10-13T16:20:00Z',
		source: 'Zendesk',
		title: 'Invoice clarity',
		body: "The invoice doesn't break down costs by Worker. We need cost allocation tags.",
		customer_tier: 'Enterprise',
	},
	{
		id: 'gold_27',
		created_at: '2025-10-14T02:00:00Z',
		source: 'Twitter',
		title: null,
		body: 'Cloudflare Workers is down! Getting 1101 errors everywhere.',
		customer_tier: 'Unknown',
	},
	{
		id: 'gold_28',
		created_at: '2025-10-14T15:00:00Z',
		source: 'GitHub Issue',
		title: 'Typescript types wrong',
		body: "The RequestInit type definition in @cloudflare/workers-types is missing the 'cf' property.",
		customer_tier: 'Pro',
	},
	{
		id: 'gold_29',
		created_at: '2025-10-15T09:45:00Z',
		source: 'Discord',
		title: 'Durable Objects alarm',
		body: "My DO alarm didn't fire at the scheduled time. It was 5 minutes late.",
		customer_tier: 'Business',
	},
	{
		id: 'gold_30',
		created_at: '2025-10-15T13:10:00Z',
		source: 'Community Forum',
		title: 'Stream API docs',
		body: 'The link to the Stream API in the sidebar 404s.',
		customer_tier: 'Free',
	},
	{
		id: 'gold_31',
		created_at: '2025-10-16T11:30:00Z',
		source: 'Zendesk',
		title: 'Subrequest limit',
		body: 'We are hitting the 50 subrequest limit. Can this be increased for Enterprise plans?',
		customer_tier: 'Enterprise',
	},
	{
		id: 'gold_32',
		created_at: '2025-10-16T14:50:00Z',
		source: 'Discord',
		title: 'Cache API Headers',
		body: 'The Cache API ignores my Vary header. Is this documented behavior?',
		customer_tier: 'Pro',
	},
	{
		id: 'gold_33',
		created_at: '2025-10-17T08:20:00Z',
		source: 'Email',
		title: 'Account Lockout',
		body: "I lost my 2FA device and the backup codes aren't working.",
		customer_tier: 'Pro',
	},
	{
		id: 'gold_34',
		created_at: '2025-10-17T17:00:00Z',
		source: 'GitHub Issue',
		title: 'Miniflare crash',
		body: 'Miniflare crashes with a segfault when using the latest Node 20 release.',
		customer_tier: 'Free',
	},
	{
		id: 'gold_35',
		created_at: '2025-10-18T10:00:00Z',
		source: 'Community Forum',
		title: 'Images Resizing pricing',
		body: 'Am I charged for the original image storage AND the resized image delivery?',
		customer_tier: 'Business',
	},
	{
		id: 'gold_36',
		created_at: '2025-10-18T12:00:00Z',
		source: 'Twitter',
		title: null,
		body: 'Love the new Workers dashboard! So much cleaner.',
		customer_tier: 'Unknown',
	},
	{
		id: 'gold_37',
		created_at: '2025-10-19T09:30:00Z',
		source: 'Discord',
		title: 'Queues Batch Size',
		body: 'Can I set a max batch size of 1 for debugging Queues? The docs say min is 10.',
		customer_tier: 'Pro',
	},
	{
		id: 'gold_38',
		created_at: '2025-10-19T14:40:00Z',
		source: 'Zendesk',
		title: 'Script Size Limit',
		body: 'Our worker bundle is 4MB. We need 10MB. We are on Enterprise.',
		customer_tier: 'Enterprise',
	},
	{
		id: 'gold_39',
		created_at: '2025-10-20T11:10:00Z',
		source: 'GitHub Issue',
		title: 'Pages Monorepo support',
		body: 'The auto-detection for monorepos in Pages fails if the root is not at the top level.',
		customer_tier: 'Free',
	},
	{
		id: 'gold_40',
		created_at: '2025-10-20T16:30:00Z',
		source: 'Community Forum',
		title: 'WebSockets disconnect',
		body: 'My websockets are being closed after exactly 100 seconds of idleness.',
		customer_tier: 'Business',
	},
	{
		id: 'gold_41',
		created_at: '2025-10-21T08:45:00Z',
		source: 'Discord',
		title: 'TCP Sockets?',
		body: 'When can we use raw TCP sockets to connect to legacy databases like Postgres?',
		customer_tier: 'Pro',
	},
	{
		id: 'gold_42',
		created_at: '2025-10-21T13:00:00Z',
		source: 'Zendesk',
		title: 'Slow dashboard',
		body: 'Loading the analytics tab takes 20 seconds. It spins forever.',
		customer_tier: 'Enterprise',
	},
	{
		id: 'gold_43',
		created_at: '2025-10-22T10:20:00Z',
		source: 'Email',
		title: 'Sales Inquiry',
		body: 'We want to migrate from AWS Lambda but we need VPC peering equivalents.',
		customer_tier: 'Enterprise',
	},
	{
		id: 'gold_44',
		created_at: '2025-10-22T15:15:00Z',
		source: 'Twitter',
		title: null,
		body: "Why is the Cloudflare dashboard dark mode not black? It's grey.",
		customer_tier: 'Free',
	},
	{
		id: 'gold_45',
		created_at: '2025-10-23T09:10:00Z',
		source: 'GitHub Issue',
		title: 'Wrangler secret put',
		body: 'Wrangler secret put fails in CI environments because it expects interactive input.',
		customer_tier: 'Pro',
	},
	{
		id: 'gold_46',
		created_at: '2025-10-23T11:50:00Z',
		source: 'Discord',
		title: 'KV consistency',
		body: 'I wrote a key and immediately read it and got the old value. I thought KV was eventually consistent but this was 10 seconds later.',
		customer_tier: 'Business',
	},
	{
		id: 'gold_47',
		created_at: '2025-10-24T14:30:00Z',
		source: 'Community Forum',
		title: 'Email Workers attachment',
		body: 'How do I parse a PDF attachment in an Email Worker?',
		customer_tier: 'Free',
	},
	{
		id: 'gold_48',
		created_at: '2025-10-24T16:10:00Z',
		source: 'Zendesk',
		title: 'Bot Fight Mode',
		body: 'Bot fight mode is blocking my own uptime monitor.',
		customer_tier: 'Pro',
	},
	{
		id: 'gold_49',
		created_at: '2025-10-25T10:00:00Z',
		source: 'Discord',
		title: 'Logpush filters',
		body: "Can I filter logpush to only send 5xx errors to Datadog? I don't want to pay for 200s.",
		customer_tier: 'Enterprise',
	},
	{
		id: 'gold_50',
		created_at: '2025-10-25T13:45:00Z',
		source: 'GitHub Issue',
		title: 'Service Binding error',
		body: "Calling a binding throws 'Error: Service not found' even though both workers are deployed.",
		customer_tier: 'Pro',
	},
];

const GOLDEN_PAIRS: Array<[string, string]> = [
	['gold_01', 'gold_02'],
	['gold_03', 'gold_04'],
	['gold_05', 'gold_06'],
	['gold_07', 'gold_08'],
	['gold_09', 'gold_10'],
	['gold_11', 'gold_12'],
	['gold_13', 'gold_14'],
	['gold_15', 'gold_16'],
	['gold_17', 'gold_18'],
	['gold_19', 'gold_20'],
];

const MESSY_SET: SeedItem[] = [
	{
		created_at: '2025-10-26T08:15:00Z',
		source: 'Discord',
		title: 'help plz',
		body: "i cant deploy. wrangler says 'unauthorized' but i just renewed my token yesterday?? this is super annoying considering i have a demo in 1 hour.",
		customer_tier: 'Free',
	},
	{
		created_at: '2025-10-26T08:45:00Z',
		source: 'Twitter',
		body: 'CLOUDFLARE IS DOWN?? My dashboard is throwing 500 errors every time I click on DNS. Fix this ASAP!!! #outage',
		customer_tier: 'Unknown',
	},
	{
		created_at: '2025-10-26T09:30:00Z',
		source: 'GitHub',
		title: 'Feature: Add Python support',
		body: 'Is there a roadmap for Python workers? JS is fine but our data science team wants to deploy inference models directly on the edge. Thanks for the great product otherwise.',
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-10-26T10:10:00Z',
		source: 'Zendesk',
		title: 'Invoicing Question - Invoice #99283',
		body: 'Hi team, looking at the R2 storage costs. We deleted 5TB of data on the 1st of the month but appear to be charged for the full month storage. Does R2 charge based on peak storage or average? The docs are vague on this.',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-10-26T11:20:00Z',
		source: 'Intercom',
		body: "Customer ID 4452 is complaining about the new navigation bar. They say they can't find the 'Purge Cache' button anymore. It used to be top right, now it's buried in a submenu. They are threatening to churn.",
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-10-26T14:00:00Z',
		source: 'Community Forum',
		title: 'Wrangler dev not reloading',
		body: 'Anyone else seeing this? > [User] detected change > [Wrangler] ... ignoring. I have to kill the process and restart it every time I change a line of code. Windows 11, Node 18.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-10-27T03:30:00Z',
		source: 'Email',
		title: null,
		body: 'Subject: URGENT - API Rate limits. We are hitting 429s on the client API. We requested a quota increase last week. Ticket #5521. Please escalate.',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-10-27T05:15:00Z',
		source: 'Discord',
		body: "is pages down? builds are stuck in 'initializing' for 20 mins now.",
		customer_tier: 'Free',
	},
	{
		created_at: '2025-10-27T08:00:00Z',
		source: 'Twitter',
		body: '@CloudflareDev can we pls get a dark mode that actually works? The contrast on the logs tab is unreadable.',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-10-27T09:45:00Z',
		source: 'Zendesk',
		title: 'Cannot bind D1',
		body: "I'm trying to bind D1 to my worker but the dashboard dropdown is empty. I created the DB 5 mins ago.",
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-10-27T11:00:00Z',
		source: 'GitHub',
		title: 'Regression in 3.1.0',
		body: "Wrangler 3.1.0 broke my build. 'Error: No such file or directory'. Rolling back to 3.0.0 fixes it.",
		customer_tier: 'Business',
	},
	{
		created_at: '2025-10-27T13:30:00Z',
		source: 'Discord',
		title: null,
		body: 'how do i use queues with python? is it supported?',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-10-28T07:10:00Z',
		source: 'Hacker News',
		title: 'Workers KV latency',
		body: 'Seeing 200ms latency on KV reads in LHR. Usually its <20ms. Is there an incident? (Comment #4492)',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-10-28T10:00:00Z',
		source: 'Email',
		body: 'Hello, I am the CTO of [Redacted]. We are considering moving our entire image pipeline to Cloudflare Images but we need to know if you support AVIF conversion on the fly.',
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-10-28T12:20:00Z',
		source: 'Twitter',
		body: 'Why is the documentation for Durable Objects so hard to follow? It feels like 3 different people wrote it.',
		customer_tier: 'Unknown',
	},
	{
		created_at: '2025-10-28T15:40:00Z',
		source: 'Salesforce',
		title: 'Account Access',
		body: 'My employee left the company and I need to revoke their access to the Cloudflare dashboard immediately.',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-10-29T02:00:00Z',
		source: 'Discord',
		body: 'wrangler tail is giving me nothing. literally blank screen.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-10-29T02:05:00Z',
		source: 'Discord',
		body: 'tail is broken for me too +1',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-10-29T02:10:00Z',
		source: 'Discord',
		body: 'same here, tail output is dead',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-10-29T04:30:00Z',
		source: 'GitHub',
		title: 'Feature Request: TCP',
		body: "Please allow raw TCP connections out of workers. I need to connect to a Redis instance that isn't HTTP based.",
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-10-29T09:00:00Z',
		source: 'Intercom',
		body: 'Feedback from sales call: Customer wants to use Workers for video transcoding but the CPU limits are too tight. Can we offer a specialized instance?',
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-10-29T11:15:00Z',
		source: 'Community Forum',
		title: 'Bill shock',
		body: 'My bill is 3x what it was last month. I see millions of requests to a worker I thought I disabled.',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-10-30T08:50:00Z',
		source: 'Twitter',
		body: 'Cloudflare Pages is the best thing since sliced bread. Just deployed my site in 30 seconds.',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-10-30T10:30:00Z',
		source: 'Zendesk',
		title: 'Audit Logs',
		body: 'We need to export audit logs to S3 for compliance. Is there an automated way to do this?',
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-10-30T14:45:00Z',
		source: 'Discord',
		body: 'anyone know how to increase the body size limit? 100mb is too small for my uploads.',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-10-31T06:00:00Z',
		source: 'GitHub',
		title: 'Typescript error',
		body: "import { D1Database } from '@cloudflare/workers-types' throws module not found.",
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-10-31T09:25:00Z',
		source: 'Email',
		body: 'I found a security vulnerability in your dashboard. Where do I report this?',
		customer_tier: 'Unknown',
	},
	{
		created_at: '2025-10-31T13:00:00Z',
		source: 'Community Forum',
		title: '522 Error',
		body: 'My site is throwing 522 Connection Timed Out. My origin is online. Help!',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-01T08:10:00Z',
		source: 'Discord',
		body: "cron triggers aren't firing. missed the last 3 hourly schedules.",
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-01T10:50:00Z',
		source: 'Twitter',
		body: 'Fix your CLI!!! It keeps asking me to login every single time I run a command.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-01T16:20:00Z',
		source: 'Zendesk',
		title: 'Stream Player',
		body: "The stream player isn't loading on iOS Safari 15. Works fine on Chrome.",
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-02T09:30:00Z',
		source: 'Intercom',
		body: "Docs team: Users are confused about the difference between 'environment' and 'service'. Seeing a lot of support tickets about this.",
		customer_tier: 'Internal',
	},
	{
		created_at: '2025-11-02T11:45:00Z',
		source: 'GitHub',
		title: 'Wrangler secret list',
		body: 'There is no command to list the names of secrets? I have to memorize them?',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-02T14:00:00Z',
		source: 'Discord',
		body: 'is D1 production ready? i lost data yesterday.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-03T03:15:00Z',
		source: 'Community Forum',
		title: 'China Network',
		body: 'Is Workers available on the China network yet? We have customers in Beijing experiencing slow loads.',
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-11-03T07:40:00Z',
		source: 'Email',
		body: 'Feature suggestion: Allow us to group Workers into folders in the dashboard. We have 50+ workers and the list is unmanageable.',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-03T12:00:00Z',
		source: 'Twitter',
		body: "@Cloudflare your 'free' plan is a lie. I got charged $5 for requests.",
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-04T09:10:00Z',
		source: 'Zendesk',
		title: 'SSO Integration',
		body: "Okta integration is failing with 'Invalid Certificate'. Please assist.",
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-11-04T13:30:00Z',
		source: 'Discord',
		body: 'can i use node modules in workers? i need lodash.',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-04T16:50:00Z',
		source: 'GitHub',
		title: "Local dev doesn't match prod",
		body: "My worker works fine in 'wrangler dev' but fails with 500 in production. The environment variables aren't loading.",
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-05T08:20:00Z',
		source: 'Community Forum',
		title: 'Cost of durable objects',
		body: "The pricing calculator for DO is confusing. What is a 'GB-second'?",
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-05T10:00:00Z',
		source: 'Discord',
		body: 'turnstile is blocking legit users. my conversion rate dropped 20%.',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-05T12:45:00Z',
		source: 'Twitter',
		body: 'Just moved to Cloudflare and my site is 2x faster. Nice.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-06T09:15:00Z',
		source: 'Zendesk',
		title: 'Dedicated IP',
		body: 'How do I purchase a dedicated IP for my worker?',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-06T11:30:00Z',
		source: 'Intercom',
		body: 'Product request: Ability to rollback a worker deployment to a specific version from the UI.',
		customer_tier: 'Internal',
	},
	{
		created_at: '2025-11-06T15:00:00Z',
		source: 'GitHub',
		title: 'Miniflare logging',
		body: 'Console logs are double printing in miniflare.',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-07T08:40:00Z',
		source: 'Discord',
		body: 'why is the cache api not caching my post requests?',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-07T10:20:00Z',
		source: 'Email',
		body: 'Urgent: We are under DDOS attack. Please enable under attack mode for zone ID xyz.',
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-11-07T14:10:00Z',
		source: 'Community Forum',
		title: 'Waiting room',
		body: 'Can I customize the HTML of the waiting room page?',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-08T06:50:00Z',
		source: 'Twitter',
		body: "API tokens are a nightmare to manage. Why can't I scope them to a specific worker?",
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-08T11:00:00Z',
		source: 'Discord',
		body: 'anyone have a snippet for basic auth? the example in docs is broken.',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-08T15:30:00Z',
		source: 'Zendesk',
		title: 'Load Balancing',
		body: 'The load balancer is sending all traffic to origin A, even though origin B is healthy.',
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-11-09T09:00:00Z',
		source: 'GitHub',
		title: 'Wrangler init fails',
		body: "Running wrangler init in an empty folder throws 'unexpected token'.",
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-09T13:15:00Z',
		source: 'Discord',
		body: 'R2 public buckets when?',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-10T08:00:00Z',
		source: 'Community Forum',
		title: 'Email Routing',
		body: "Emails aren't being forwarded to my gmail. Verified DNS is correct.",
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-10T10:45:00Z',
		source: 'Twitter',
		body: 'Cloudflare support is ghosting me. Ticket #12345 open for 5 days.',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-10T14:20:00Z',
		source: 'Intercom',
		body: "Customer confusing 'Pages' with 'Workers Sites'. We need to deprecate Sites faster.",
		customer_tier: 'Internal',
	},
	{
		created_at: '2025-11-11T05:00:00Z',
		source: 'Discord',
		body: 'getting error 1015 rate limited but i have no rate limiting rules set up.',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-11T09:30:00Z',
		source: 'Zendesk',
		title: 'Argo Tunnel',
		body: "Cloudflared disconnects every 2 hours. Logs show 'context deadline exceeded'.",
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-11T12:50:00Z',
		source: 'GitHub',
		title: 'Feature: workspaces',
		body: 'Support yarn workspaces in pages build.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-12T08:10:00Z',
		source: 'Email',
		body: "I can't pay my bill. The credit card form is broken.",
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-12T11:00:00Z',
		source: 'Discord',
		body: 'kv writes are failing with 500s. anyone else?',
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-11-12T15:00:00Z',
		source: 'Twitter',
		body: "Why do I have to use Wrangler? Can't I just upload a zip file?",
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-13T09:40:00Z',
		source: 'StackOverflow',
		title: 'Web3 gateway',
		body: "Is the IPFS gateway deprecated? It's very slow. I'm getting timeouts on 50% of requests.",
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-13T12:25:00Z',
		source: 'Zendesk',
		title: 'Zone lockdown',
		body: 'I locked myself out of my own zone with a firewall rule. Please reset.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-14T08:50:00Z',
		source: 'Discord',
		body: 'vectorize is cool but the latency is too high for my search use case.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-14T11:15:00Z',
		source: 'GitHub',
		title: 'D1 backups',
		body: 'Add command to download D1 backup to local sql file.',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-14T14:30:00Z',
		source: 'Twitter',
		body: 'Cloudflare Workers + Hono is the best stack right now.',
		customer_tier: 'Unknown',
	},
	{
		created_at: '2025-11-15T10:00:00Z',
		source: 'Salesforce',
		body: 'Big enterprise customer wants to run Cobol on Workers (via WASM). They need help compiling it.',
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-11-15T13:45:00Z',
		source: 'Discord',
		body: 'help, my worker is consuming too much ram and crashing. how do i profile memory?',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-16T09:20:00Z',
		source: 'Community Forum',
		title: 'DNS Propagation',
		body: 'Changed NS records 48 hours ago, still not active.',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-16T12:00:00Z',
		source: 'Zendesk',
		title: 'Custom SSL',
		body: "My custom cert isn't deploying to the edge.",
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-17T08:30:00Z',
		source: 'GitHub',
		title: 'Pages functions',
		body: "_middleware.ts isn't running on child routes.",
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-17T11:40:00Z',
		source: 'Discord',
		body: "where is the 'usage' tab? did it move?",
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-18T09:10:00Z',
		source: 'Email',
		body: 'We need a BAA (Business Associate Agreement) for HIPAA compliance. Who do we talk to?',
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-11-18T14:50:00Z',
		source: 'Twitter',
		body: "Cloudflare implies they support Websockets but they close them so fast it's useless.",
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-19T07:15:00Z',
		source: 'Discord',
		body: 'can i run puppeteer in workers?',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-19T10:30:00Z',
		source: 'Zendesk',
		title: 'Image Resizing',
		body: 'Images are coming back pixelated when I use format=webp.',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-20T08:00:00Z',
		source: 'Community Forum',
		title: 'Worker to Worker latency',
		body: 'Service bindings seem slower than HTTP fetch today.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-20T12:45:00Z',
		source: 'GitHub',
		title: 'Wrangler deploy --dry-run',
		body: 'Add a dry run flag to see what files will be uploaded.',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-21T09:50:00Z',
		source: 'Discord',
		body: 'my analytics show 0 visitors but i know people are on the site.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-21T13:20:00Z',
		source: 'Twitter',
		body: "The caching on Cloudflare is too aggressive. It's caching my admin panel.",
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-22T10:00:00Z',
		source: 'Intercom',
		body: "Customer asking for refund on Load Balancing. They claim it didn't failover during the AWS outage.",
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-22T15:30:00Z',
		source: 'Zendesk',
		title: 'Domain Transfer',
		body: 'Auth code is invalid for domain transfer.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-23T08:15:00Z',
		source: 'Discord',
		body: 'is there a way to view live logs for pages functions?',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-23T11:40:00Z',
		source: 'GitHub',
		title: 'Bug: KV ttl',
		body: 'Keys are not expiring after the set TTL.',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-24T09:00:00Z',
		source: 'Community Forum',
		title: 'Redirect Rules',
		body: 'Regex redirect not matching query parameters.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-24T14:10:00Z',
		source: 'Email',
		body: 'Legal DMCA Takedown Request. [Attached]',
		customer_tier: 'Unknown',
	},
	{
		created_at: '2025-11-25T10:30:00Z',
		source: 'Twitter',
		body: 'Workers AI is mind blowing. Just built a chatbot in 10 mins.',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-25T13:00:00Z',
		source: 'Discord',
		body: 'how do i delete a worker? i cant find the button.',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-26T08:45:00Z',
		source: 'Zendesk',
		title: 'API Shield',
		body: 'Schema validation is rejecting valid JSON requests.',
		customer_tier: 'Enterprise',
	},
	{
		created_at: '2025-11-26T11:15:00Z',
		source: 'GitHub',
		title: 'Wrangler publish deprecated',
		body: "Warning says publish is deprecated but deploy docs aren't ready.",
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-27T04:00:00Z',
		source: 'Discord',
		body: "my build failed with 'unknown error'. super helpful.",
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-27T09:30:00Z',
		source: 'G2 Crowd',
		title: 'Spectrum protocols',
		body: 'Does Spectrum support UDP for gaming? We are evaluating for our new title.',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-28T08:20:00Z',
		source: 'Twitter',
		body: 'Cloudflare dashboard on mobile is impossible to use.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-28T12:00:00Z',
		source: 'Intercom',
		body: 'Engineering: We are seeing a spike in 500s on the dashboard API.',
		customer_tier: 'Internal',
	},
	{
		created_at: '2025-11-29T07:50:00Z',
		source: 'Discord',
		body: 'can i use rust with workers?',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-29T10:40:00Z',
		source: 'Zendesk',
		title: 'Billing Contact',
		body: 'Need to update the email address for invoices.',
		customer_tier: 'Business',
	},
	{
		created_at: '2025-11-29T14:15:00Z',
		source: 'GitHub',
		title: 'Feature: multiple triggers',
		body: 'Allow multiple cron triggers for a single worker.',
		customer_tier: 'Pro',
	},
	{
		created_at: '2025-11-30T09:00:00Z',
		source: 'Reddit',
		title: null,
		body: 'Is it just me or is the Cloudflare dashboard really slow today? It takes like 10 seconds to load the DNS tab.',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-30T11:30:00Z',
		source: 'SpamBot',
		title: 'Buy Followers',
		body: 'Cheap instagram followers visit www.fake.com',
		customer_tier: 'Unknown',
	},
	{
		created_at: '2025-11-30T13:00:00Z',
		source: 'Discord',
		body: 'broken',
		customer_tier: 'Free',
	},
	{
		created_at: '2025-11-30T15:00:00Z',
		source: 'Discord',
		body: 'test',
		customer_tier: 'Internal',
	},
	{
		created_at: '2025-11-30T16:00:00Z',
		source: 'Salesforce',
		body: '',
		customer_tier: 'Business',
	},
];

type SeedItem = {
	id?: string;
	source?: string;
	title?: string | null;
	body?: string;
	customer_tier?: string | null;
	created_at?: string;
};

async function seedGoldenSet(
	env: Env,
	items: SeedItem[] = GOLDEN_SET,
	duplicatePairs: Array<[string, string]> = GOLDEN_PAIRS
): Promise<{ inserted: string[]; duplicate_pairs: Array<[string, string]>; skipped: Array<{ id?: string; reason: string }> }> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) throw new Error('Missing DB binding');
	const db = dbBinding.value;
	const inserted: string[] = [];
	const skipped: Array<{ id?: string; reason: string }> = [];
	for (const item of items) {
		const id = item.id || crypto.randomUUID();
		const existing = await db.prepare('SELECT id FROM feedback WHERE id = ?').bind(id).first();
		if (existing) {
			skipped.push({ id, reason: 'Already exists' });
			continue;
		}
		const validated = validateFeedbackInput({
			source: item.source,
			title: item.title ?? '',
			body: item.body,
			customer_tier: item.customer_tier ?? '',
		});
		if (validated.error) {
			skipped.push({ id, reason: 'Validation failed' });
			continue;
		}
		const createdAt =
			item.created_at && !Number.isNaN(Date.parse(item.created_at)) ? item.created_at : nowIso();
		await db
			.prepare(
				`INSERT INTO feedback (id, source, title, body, customer_tier, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.bind(
				id,
				validated.value!.source,
				validated.value!.title || null,
				validated.value!.body,
				validated.value!.customer_tier || null,
				createdAt
			)
			.run();
		inserted.push(id);
	}
	return { inserted, duplicate_pairs: duplicatePairs, skipped };
}

async function searchApi(env: Env, query: string): Promise<{ results: any[]; note?: string }> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return { results: [], note: 'Missing DB binding' };
	const db = dbBinding.value;
	if (env.VEC) {
		const embedding = await embedText(env, query);
		if (!embedding.vector) return { results: [], note: embedding.error || 'Embedding failed' };
		const vecResult = await env.VEC.query(embedding.vector, { topK: 5, returnMetadata: true });
		const matches = vecResult?.matches || vecResult?.result || [];
		const ids = matches.map((match: any) => match.id).filter((id: string) => id);
		if (ids.length === 0) return { results: [] };
		const placeholders = ids.map(() => '?').join(', ');
		const rows = await db
			.prepare(
				`SELECT f.id, f.title, f.body, f.source, f.created_at, a.theme, a.summary
         FROM feedback f
         LEFT JOIN analysis a ON f.id = a.feedback_id
         WHERE f.id IN (${placeholders})`
			)
			.bind(...ids)
			.all();
		const rowMap = new Map((rows.results || []).map((row: any) => [row.id, row]));
		const ordered = ids.map((id: string) => rowMap.get(id)).filter(Boolean);
		return { results: ordered };
	}
	const likeQuery = `%${query}%`;
	const rows = await db
		.prepare(
			`SELECT f.id, f.title, f.body, f.source, f.created_at, a.theme, a.summary
       FROM feedback f
       LEFT JOIN analysis a ON f.id = a.feedback_id
       WHERE f.title LIKE ? OR f.body LIKE ?
       ORDER BY f.created_at DESC
       LIMIT 5`
		)
		.bind(likeQuery, likeQuery)
		.all();
	return { results: rows.results || [], note: 'Vectorize not configured' };
}

function extractSeedPayload(value: any): { items: SeedItem[]; duplicate_pairs: Array<[string, string]> } {
	if (Array.isArray(value)) {
		return { items: value, duplicate_pairs: GOLDEN_PAIRS };
	}
	const items = Array.isArray(value?.items) ? value.items : GOLDEN_SET;
	let duplicate_pairs = GOLDEN_PAIRS;
	if (Array.isArray(value?.duplicate_pairs)) {
		const pairs = value.duplicate_pairs
			.filter((pair: any) => Array.isArray(pair) && pair.length === 2 && pair.every((id: any) => typeof id === 'string'))
			.map((pair: any) => [pair[0], pair[1]] as [string, string]);
		if (pairs.length) duplicate_pairs = pairs;
	}
	return { items, duplicate_pairs };
}

async function handleBulkIngest(env: Env, request: Request): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return dbBinding.error;
	const parsed = await parseJSONOptional(request, 500000);
	if (parsed.error) return parsed.error;
	const payload = parsed.empty ? MESSY_SET : parsed.value;
	const items = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : null;
	if (!items) return errorResponse('Bulk payload must be an array or { items: [] }', 400);
	const inserted: string[] = [];
	const skipped: Array<{ index: number; reason: string }> = [];
	const stmt = dbBinding.value.prepare(
		'INSERT OR IGNORE INTO feedback (id, source, title, body, customer_tier, created_at) VALUES (?, ?, ?, ?, ?, ?)'
	);
	for (let i = 0; i < items.length; i += 1) {
		const item = items[i];
		const validated = validateFeedbackInput({
			source: item?.source,
			title: item?.title ?? '',
			body: item?.body,
			customer_tier: item?.customer_tier ?? '',
		});
		if (validated.error) {
			skipped.push({ index: i, reason: 'Validation failed' });
			continue;
		}
		const id = typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : crypto.randomUUID();
		const createdAt =
			typeof item?.created_at === 'string' && !Number.isNaN(Date.parse(item.created_at))
				? item.created_at
				: nowIso();
		const result = await stmt
			.bind(
				id,
				validated.value!.source,
				validated.value!.title || null,
				validated.value!.body,
				validated.value!.customer_tier || null,
				createdAt
			)
			.run();
		const changes = (result as any)?.meta?.changes ?? 0;
		if (changes === 0) {
			skipped.push({ index: i, reason: 'Duplicate id' });
			continue;
		}
		inserted.push(id);
	}
	return jsonResponse({ inserted_count: inserted.length, inserted_ids: inserted, skipped });
}

async function handleAnalyze(env: Env, id: string): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return dbBinding.error;
	const feedback = await fetchFeedbackById(dbBinding.value, id);
	if (!feedback) return errorResponse('Feedback not found', 404);
	const analysisResult = await analyzeAndStore(env, feedback);
	if (analysisResult.error) return analysisResult.error;
	return jsonResponse(analysisResult.analysis);
}

async function handleThemesApi(env: Env): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return dbBinding.error;
	const db = dbBinding.value;
	const themeRows = await db.prepare('SELECT theme, COUNT(*) as count FROM analysis GROUP BY theme ORDER BY count DESC').all();
	const result = [] as Array<{ theme: string; count: number; examples: string[] }>;
	for (const row of themeRows.results || []) {
		const examples = await db
			.prepare('SELECT feedback_id FROM analysis WHERE theme = ? ORDER BY analyzed_at DESC LIMIT 2')
			.bind(row.theme)
			.all();
		result.push({
			theme: row.theme,
			count: row.count,
			examples: (examples.results || []).map((ex: any) => ex.feedback_id),
		});
	}
	return jsonResponse(result);
}

async function handleEvalRun(env: Env): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return dbBinding.error;
	const aiBinding = requireBinding(env.AI, 'AI');
	if (aiBinding.error) return aiBinding.error;
	try {
		await seedGoldenSet(env);
	} catch (err) {
		return errorResponse('Failed to seed golden set', 500);
	}
	const db = dbBinding.value;
	let validJsonCount = 0;
	let validThemeCount = 0;
	const createdAt = nowIso();
	const runId = crypto.randomUUID();
	const cases: Array<{ feedback_id: string; json_valid: number; theme_valid: number; recall_hit: number | null; notes: string | null }> = [];
	for (const item of GOLDEN_SET) {
		const feedback = await fetchFeedbackById(db, item.id);
		if (!feedback) continue;
		const analysisResult = await analyzeAndStore(env, feedback);
		if (analysisResult.error || !analysisResult.analysis) {
			cases.push({ feedback_id: item.id, json_valid: 0, theme_valid: 0, recall_hit: null, notes: 'Analysis failed' });
			continue;
		}
		validJsonCount += 1;
		const themeValid = themeIsValid(analysisResult.analysis.theme) ? 1 : 0;
		validThemeCount += themeValid;
		cases.push({ feedback_id: item.id, json_valid: 1, theme_valid: themeValid, recall_hit: null, notes: null });
	}
	let recallAt3: number | null = null;
	if (env.VEC) {
		let hitCount = 0;
		for (const [idA, idB] of GOLDEN_PAIRS) {
			const feedback = await fetchFeedbackById(db, idA);
			if (!feedback) continue;
			const similar = await searchApi(env, `${feedback.title || ''}\n${feedback.body}`);
			const top3 = similar.results.slice(0, 3).map((row: any) => row.id);
			const hit = top3.includes(idB) ? 1 : 0;
			hitCount += hit;
			const caseRow = cases.find((entry) => entry.feedback_id === idA);
			if (caseRow) {
				caseRow.recall_hit = hit;
				caseRow.notes = hit ? caseRow.notes : 'Recall miss';
			}
		}
		recallAt3 = GOLDEN_PAIRS.length ? hitCount / GOLDEN_PAIRS.length : null;
	} else {
		for (const [idA] of GOLDEN_PAIRS) {
			const caseRow = cases.find((entry) => entry.feedback_id === idA);
			if (caseRow) {
				caseRow.recall_hit = null;
				caseRow.notes = 'Vectorize not configured';
			}
		}
	}
	const totalCases = cases.length;
	const jsonValidRate = totalCases ? validJsonCount / totalCases : 0;
	const themeValidRate = totalCases ? validThemeCount / totalCases : 0;
	await db
		.prepare(
			`INSERT INTO eval_runs (id, created_at, model, prompt_version, total_cases, json_valid_rate, theme_valid_rate, recall_at_3)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(runId, createdAt, ANALYSIS_MODEL, PROMPT_VERSION, totalCases, jsonValidRate, themeValidRate, recallAt3)
		.run();
	for (const row of cases) {
		await db
			.prepare(
				`INSERT INTO eval_cases (run_id, feedback_id, json_valid, theme_valid, recall_hit, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
			)
			.bind(runId, row.feedback_id, row.json_valid, row.theme_valid, row.recall_hit, row.notes)
			.run();
	}
	return jsonResponse({
		run_id: runId,
		created_at: createdAt,
		total_cases: totalCases,
		json_valid_rate: jsonValidRate,
		theme_valid_rate: themeValidRate,
		recall_at_3: recallAt3,
	});
}

async function handleEvalLatest(env: Env): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return dbBinding.error;
	const db = dbBinding.value;
	const latest = (await db.prepare('SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT 1').first()) as any;
	const failures = await db
		.prepare('SELECT * FROM eval_cases WHERE json_valid = 0 OR theme_valid = 0 OR recall_hit = 0 ORDER BY rowid DESC LIMIT 10')
		.all();
	return jsonResponse({ latest, failing_cases: failures.results || [] });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;
		try {
			if (request.method === 'GET' && pathname === '/') {
				return await renderInbox(env);
			}
			if (request.method === 'GET' && pathname === '/themes') {
				return await renderThemes(env);
			}
			if (request.method === 'GET' && pathname === '/feedback') {
				const id = url.searchParams.get('id');
				if (!id) return htmlResponse(renderLayout('Feedback', '<div class="card">Missing id.</div>'), 400);
				return await renderFeedbackDetail(env, id);
			}
			if (request.method === 'GET' && pathname === '/eval') {
				return await renderEval(env);
			}
			if (request.method === 'POST' && pathname === '/api/feedback') {
				const parsed = await parseFeedbackPayload(request);
				if (parsed.error) return parsed.error;
				const validated = validateFeedbackInput(parsed.value || {});
				if (validated.error) return validated.error;
				const dbBinding = requireBinding(env.DB, 'DB');
				if (dbBinding.error) return dbBinding.error;
				const id = crypto.randomUUID();
				const createdAt = nowIso();
				await dbBinding.value
					.prepare('INSERT INTO feedback (id, source, title, body, customer_tier, created_at) VALUES (?, ?, ?, ?, ?, ?)')
					.bind(
						id,
						validated.value!.source,
						validated.value!.title || null,
						validated.value!.body,
						validated.value!.customer_tier || null,
						createdAt
					)
					.run();
				if (parsed.isForm) {
					return Response.redirect(`/feedback?id=${encodeURIComponent(id)}`, 303);
				}
				return jsonResponse({ id });
			}
			if (request.method === 'POST' && pathname === '/api/feedback/bulk') {
				return await handleBulkIngest(env, request);
			}
			if (request.method === 'POST' && pathname.startsWith('/api/feedback/') && pathname.endsWith('/analyze')) {
				const parts = pathname.split('/');
				const id = parts[3];
				if (!id) return errorResponse('Missing feedback id', 400);
				return await handleAnalyze(env, id);
			}
			if (request.method === 'GET' && pathname === '/api/themes') {
				return await handleThemesApi(env);
			}
			if (request.method === 'GET' && pathname === '/api/search') {
				const q = url.searchParams.get('q') || '';
				if (!q.trim()) return errorResponse('Missing query', 400);
				const dbBinding = requireBinding(env.DB, 'DB');
				if (dbBinding.error) return dbBinding.error;
				if (env.VEC) {
					const aiBinding = requireBinding(env.AI, 'AI');
					if (aiBinding.error) return aiBinding.error;
				}
				const result = await searchApi(env, q.trim());
				return jsonResponse(result);
			}
			if (request.method === 'POST' && pathname === '/api/eval/seed') {
				try {
					const parsed = await parseJSONOptional(request, 500000);
					if (parsed.error) return parsed.error;
					const payload = parsed.empty ? undefined : parsed.value;
					const { items, duplicate_pairs } = extractSeedPayload(payload);
					const seedResult = await seedGoldenSet(env, items, duplicate_pairs);
					return jsonResponse({
						inserted_ids: seedResult.inserted,
						duplicate_pairs: seedResult.duplicate_pairs,
						skipped: seedResult.skipped,
					});
				} catch (err) {
					return errorResponse('Failed to seed golden set', 500);
				}
			}
			if (request.method === 'POST' && pathname === '/api/eval/run') {
				return await handleEvalRun(env);
			}
			if (request.method === 'GET' && pathname === '/api/eval/latest') {
				return await handleEvalLatest(env);
			}
			return new Response('Not Found', { status: 404 });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Server error';
			return errorResponse(`Server error: ${message}`, 500);
		}
	},
} satisfies ExportedHandler<Env>;
