import { ANALYSIS_MODEL, EMBED_MODEL, THEME_TAXONOMY, type Env, type FeedbackRow } from './constants';
import { requireBinding, themeIsValid } from './utils';

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

async function runAiAnalysis(
	env: Env,
	feedback: FeedbackRow
): Promise<{ analysis?: any; error?: string; raw?: string }> {
	const aiBinding = requireBinding(env.AI, 'AI');
	if (aiBinding.error) return { error: 'Missing binding: AI' };

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
			temperature: 0.1,
			max_tokens: 500,
		});
		rawText = extractAiText(aiResult);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'AI request failed';
		return { error: message };
	}

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
		return { error: 'Invalid JSON from AI', raw: rawText };
	}
}

export async function runAiAnalysisWithRetry(
	env: Env,
	feedback: FeedbackRow
): Promise<{ analysis?: any; error?: string; raw?: string }> {
	let result = await runAiAnalysis(env, feedback);
	if (result.analysis) return result;

	const aiBinding = requireBinding(env.AI, 'AI');
	if (aiBinding.error) return { error: 'Missing binding: AI' };

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
			temperature: 0.05,
			max_tokens: 500,
		});
		rawText = extractAiText(aiResult);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'AI request failed';
		return { error: message };
	}

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

export async function embedText(env: Env, text: string): Promise<{ vector?: number[]; error?: string }> {
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
