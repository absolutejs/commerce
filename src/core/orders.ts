// Order + fulfillment lifecycle. Status is the high-level state; an order in
// `paid` moves through production stages before it ships.

export type OrderStatus =
	| 'paid'
	| 'shipped'
	| 'rejected'
	| 'failed'
	| 'refunded';

// A B2B quote moves new → priced (shop replies) → won/lost.
export type QuoteStatus = 'new' | 'priced' | 'won' | 'lost';

// A proof goes none → sent → approved | changes (customer responds).
export type ProofStatus = 'none' | 'sent' | 'approved' | 'changes';

const clampPercent = (percent: number) => Math.min(100, Math.max(0, percent));

/** Deposit owed (minor units) for a total at a given percent (0 if percent≤0). */
export const depositCents = (totalCents: number, percent: number) =>
	percent > 0 ? Math.round((totalCents * clampPercent(percent)) / 100) : 0;

export const PRODUCTION_STAGES = [
	'queued',
	'digitizing',
	'production',
	'ready'
] as const;
export type ProductionStage = (typeof PRODUCTION_STAGES)[number];

const stageIndex = (stage: string) =>
	(PRODUCTION_STAGES as readonly string[]).indexOf(stage);

/** Normalize an unknown stage to a valid one (defaults to the first). */
export const toProductionStage = (stage: string | null | undefined) =>
	stage && stageIndex(stage) >= 0
		? (stage as ProductionStage)
		: PRODUCTION_STAGES[0];

/** The next stage forward, or null at the end. */
export const nextStage = (stage: string): ProductionStage | null =>
	PRODUCTION_STAGES[stageIndex(toProductionStage(stage)) + 1] ?? null;

/** The previous stage, or null at the start. */
export const prevStage = (stage: string): ProductionStage | null => {
	const index = stageIndex(toProductionStage(stage));

	return index > 0 ? PRODUCTION_STAGES[index - 1] ?? null : null;
};
