import type { Env, FeedbackRow } from './constants';
import { embedText } from './ai';
import { requireBinding } from './utils';

export type SearchResult = { id: string; title: string | null; theme: string | null };

export async function upsertVector(env: Env, feedback: FeedbackRow, analysis: any): Promise<void> {
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

export async function searchSimilar(
	env: Env,
	feedback: FeedbackRow,
	limit = 5
): Promise<{ items: SearchResult[]; note?: string }> {
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
