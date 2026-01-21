import type { Env } from './constants';
import {
	extractSeedPayload,
	handleAnalyze,
	handleBulkIngest,
	handleEvalLatest,
	handleEvalRun,
	handleThemesApi,
	searchApi,
	seedGoldenSet,
} from './handlers';
import { renderEval, renderFeedbackDetail, renderInbox, renderMessagePage, renderThemes } from './ui';
import {
	errorResponse,
	jsonResponse,
	nowIso,
	parseFeedbackPayload,
	parseJSONOptional,
	requireBinding,
	validateFeedbackInput,
} from './utils';

export default {
	async fetch(request, env): Promise<Response> {
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
				if (!id) return renderMessagePage('Feedback', 'Missing id.');
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
