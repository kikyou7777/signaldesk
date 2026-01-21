import type { FeedbackRow } from './constants';

export async function fetchFeedbackById(db: D1Database, id: string): Promise<FeedbackRow | null> {
	const result = await db.prepare('SELECT * FROM feedback WHERE id = ?').bind(id).first();
	return (result as FeedbackRow) || null;
}

export async function listRecentFeedback(db: D1Database): Promise<any[]> {
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
