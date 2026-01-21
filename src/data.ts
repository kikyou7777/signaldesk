import goldenDataset from '../golden_dataset.json';
import messyDataset from '../messy_data.json';
import type { SeedItem } from './constants';

type GoldenRecord = SeedItem & {
	duplicate_pair_id?: string | null;
	ground_truth_theme?: string | null;
};

function buildDuplicatePairs(items: GoldenRecord[]): Array<[string, string]> {
	const groups = new Map<string, string[]>();
	for (const item of items) {
		if (!item.duplicate_pair_id || !item.id) continue;
		const ids = groups.get(item.duplicate_pair_id) ?? [];
		ids.push(item.id);
		groups.set(item.duplicate_pair_id, ids);
	}
	const pairs: Array<[string, string]> = [];
	for (const ids of groups.values()) {
		const unique = Array.from(new Set(ids)).sort();
		for (let i = 0; i + 1 < unique.length; i += 2) {
			pairs.push([unique[i], unique[i + 1]]);
		}
	}
	return pairs;
}

const GOLDEN_RECORDS = goldenDataset as GoldenRecord[];

export const GOLDEN_SET: SeedItem[] = GOLDEN_RECORDS.map(({ duplicate_pair_id, ground_truth_theme, ...rest }) => rest);
export const GOLDEN_PAIRS: Array<[string, string]> = buildDuplicatePairs(GOLDEN_RECORDS);
export const MESSY_SET: SeedItem[] = (messyDataset as SeedItem[]).map((item) => ({ ...item }));
