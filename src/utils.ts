import {
	ALLOWED_SOURCES,
	MAX_BODY_BYTES,
	MAX_BODY_CHARS,
	MAX_TIER_CHARS,
	MAX_TITLE_CHARS,
	THEME_TAXONOMY,
	type Theme,
} from './constants';

export function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			...headers,
		},
	});
}

export function htmlResponse(html: string, status = 200): Response {
	return new Response(html, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
		},
	});
}

export function errorResponse(message: string, status = 400, extras?: Record<string, unknown>): Response {
	return jsonResponse({ error: message, ...extras }, status);
}

export function htmlEscape(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export async function parseJSON(
	request: Request,
	maxBytes = MAX_BODY_BYTES
): Promise<{ value?: any; error?: Response }> {
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

export async function parseJSONOptional(
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

export function requireBinding<T>(binding: T | undefined, name: string): { value?: T; error?: Response } {
	if (!binding) {
		return { error: errorResponse(`Missing binding: ${name}`, 500) };
	}
	return { value: binding };
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function toSeverity(urgencyScore: number): string {
	if (urgencyScore >= 70) return 'high';
	if (urgencyScore >= 40) return 'medium';
	return 'low';
}

export function themeIsValid(theme: string): theme is Theme {
	return THEME_TAXONOMY.includes(theme as Theme);
}

export function normalizeText(value: string | null | undefined): string {
	return value ? value.trim() : '';
}

export function normalizeSource(value: unknown): string {
	if (typeof value !== 'string') return '';
	return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function parseFeedbackPayload(
	request: Request
): Promise<{ value?: any; error?: Response; isForm?: boolean }> {
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

export function validateFeedbackInput(input: any): {
	value?: { source: string; title?: string; body: string; customer_tier?: string };
	error?: Response;
} {
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
