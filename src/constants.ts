export const MAX_BODY_BYTES = 20000;
export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 8000;
export const MAX_TIER_CHARS = 50;
export const THEME_TAXONOMY = [
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
export const ALLOWED_SOURCES = [
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
export const ANALYSIS_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
export const PROMPT_VERSION = 'v1';

export type Theme = (typeof THEME_TAXONOMY)[number];

export type FeedbackRow = {
	id: string;
	source: string;
	title: string | null;
	body: string;
	customer_tier: string | null;
	created_at: string;
};

export type AnalysisRow = {
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

export type SeedItem = {
	id?: string;
	source?: string;
	title?: string | null;
	body?: string;
	customer_tier?: string | null;
	created_at?: string;
};

export type Env = {
	DB?: D1Database;
	AI?: any;
	VEC?: any;
};
