import { embedText, runAiAnalysisWithRetry } from './ai';
import {
	ANALYSIS_MODEL,
	PROMPT_VERSION,
	type AnalysisRow,
	type Env,
	type FeedbackRow,
	type SeedItem,
} from './constants';
import { GOLDEN_PAIRS, GOLDEN_SET, MESSY_SET } from './data';
import { fetchFeedbackById } from './db';
import { upsertVector } from './vectorize';
import {
	errorResponse,
	jsonResponse,
	nowIso,
	parseJSONOptional,
	requireBinding,
	themeIsValid,
	toSeverity,
	validateFeedbackInput,
} from './utils';

export async function seedGoldenSet(
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

export function extractSeedPayload(value: any): { items: SeedItem[]; duplicate_pairs: Array<[string, string]> } {
	if (Array.isArray(value)) {
		return { items: value, duplicate_pairs: GOLDEN_PAIRS };
	}
	const items = Array.isArray(value?.items) ? value.items : GOLDEN_SET;
	let duplicate_pairs = GOLDEN_PAIRS;
	if (Array.isArray(value?.duplicate_pairs)) {
		duplicate_pairs = value.duplicate_pairs;
	}
	return { items, duplicate_pairs };
}

export async function handleBulkIngest(
	env: Env,
	request: Request,
	options?: { analyze?: boolean; ctx?: ExecutionContext }
): Promise<Response> {
	const parsed = await parseJSONOptional(request, 500000);
	if (parsed.error) return parsed.error;
	const payload = parsed.empty ? MESSY_SET : parsed.value;
	if (!Array.isArray(payload)) {
		return errorResponse('Expected JSON array payload', 400);
	}
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return dbBinding.error;
	const db = dbBinding.value;
	const inserted: string[] = [];
	const skipped: Array<{ index: number; reason: string }> = [];
	const analysisTasks: Promise<void>[] = [];
	for (let i = 0; i < payload.length; i += 1) {
		const item = payload[i];
		const validated = validateFeedbackInput(item);
		if (validated.error) {
			skipped.push({ index: i, reason: 'Validation failed' });
			continue;
		}
		const id = item.id || crypto.randomUUID();
		const createdAt = nowIso();
		const result = await db
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
		const changes = (result as any)?.meta?.changes ?? 0;
		if (changes === 0) {
			skipped.push({ index: i, reason: 'Duplicate id' });
			continue;
		}
		inserted.push(id);
		if (options?.analyze) {
			analysisTasks.push(analyzeFeedbackById(env, id));
		}
	}
	if (analysisTasks.length) {
		const all = Promise.allSettled(analysisTasks);
		if (options?.ctx) {
			options.ctx.waitUntil(all);
		} else {
			await all;
		}
	}
	return jsonResponse({ inserted_count: inserted.length, inserted_ids: inserted, skipped });
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

export async function analyzeFeedbackById(env: Env, id: string): Promise<void> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return;
	const feedback = await fetchFeedbackById(dbBinding.value, id);
	if (!feedback) return;
	await analyzeAndStore(env, feedback);
}

export async function handleAnalyze(env: Env, id: string): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return dbBinding.error;
	const feedback = await fetchFeedbackById(dbBinding.value, id);
	if (!feedback) return errorResponse('Feedback not found', 404);
	const analysisResult = await analyzeAndStore(env, feedback);
	if (analysisResult.error) return analysisResult.error;
	return jsonResponse(analysisResult.analysis);
}

export async function handleThemesApi(env: Env): Promise<Response> {
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

export async function searchApi(env: Env, query: string): Promise<{ results: any[]; note?: string }> {
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

export async function handleEvalRun(env: Env): Promise<Response> {
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
		const feedback = await fetchFeedbackById(db, item.id || '');
		if (!feedback) continue;
		const analysisResult = await analyzeAndStore(env, feedback);
		if (analysisResult.error || !analysisResult.analysis) {
			cases.push({ feedback_id: feedback.id, json_valid: 0, theme_valid: 0, recall_hit: null, notes: 'Analysis failed' });
			continue;
		}
		validJsonCount += 1;
		const themeValid = themeIsValid(analysisResult.analysis.theme) ? 1 : 0;
		validThemeCount += themeValid;
		cases.push({ feedback_id: feedback.id, json_valid: 1, theme_valid: themeValid, recall_hit: null, notes: null });
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

export async function handleEvalLatest(env: Env): Promise<Response> {
	const dbBinding = requireBinding(env.DB, 'DB');
	if (dbBinding.error) return dbBinding.error;
	const db = dbBinding.value;
	const latest = (await db.prepare('SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT 1').first()) as any;
	const failures = await db
		.prepare('SELECT * FROM eval_cases WHERE json_valid = 0 OR theme_valid = 0 OR recall_hit = 0 ORDER BY rowid DESC LIMIT 10')
		.all();
	return jsonResponse({ latest, failing_cases: failures.results || [] });
}
