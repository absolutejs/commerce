import type { StorefrontDisputeEscalationStatus } from "../core/aftercare";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { CommerceDb } from "./queries";
import {
  commerceStorefrontCaseEscalations,
  commerceStorefrontCaseEvidenceSubmissions,
  commerceStorefrontCases,
} from "./index";
import { StorefrontAftercareError } from "./storefrontAftercare";

const DEFAULT_CYCLE_LIMIT = 10;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETRY_MS = 60_000;
const terminalStatuses: StorefrontDisputeEscalationStatus[] = [
  "acknowledged",
  "resolved",
];

export type StorefrontCaseEscalation =
  typeof commerceStorefrontCaseEscalations.$inferSelect;

export type StorefrontDisputeOutcomeAnalytics = {
  acknowledgement: {
    acknowledged: number;
    averageMinutes: number | null;
    open: number;
    promoted: number;
  };
  evidence: {
    lostWithEvidence: number;
    lostWithoutEvidence: number;
    wonWithEvidence: number;
    wonWithoutEvidence: number;
  };
  outcomes: {
    active: number;
    lost: number;
    otherTerminal: number;
    total: number;
    won: number;
  };
};

type OutcomeRow = {
  active: number | string;
  lost: number | string;
  lost_with_evidence: number | string;
  lost_without_evidence: number | string;
  other_terminal: number | string;
  total: number | string;
  won: number | string;
  won_with_evidence: number | string;
  won_without_evidence: number | string;
};

type AcknowledgementRow = {
  acknowledged: number | string;
  average_minutes: number | string | null;
  open: number | string;
  promoted: number | string;
};

const count = (value: number | string) => Number(value);

export const createStorefrontAftercareEscalationService = (options: {
  db: CommerceDb;
  enabled?: boolean;
  leaseMs?: number;
  now?: () => Date;
  promoteIncident: (input: {
    escalation: StorefrontCaseEscalation;
    idempotencyKey: string;
  }) => Promise<{ reference: string }>;
  retryMs?: number;
}) => {
  const enabled = options.enabled ?? false;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? (() => new Date());
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;

  const escalationFor = async (ownerKey: string, escalationId: string) => {
    const [entry] = await options.db
      .select()
      .from(commerceStorefrontCaseEscalations)
      .where(
        and(
          eq(commerceStorefrontCaseEscalations.id, escalationId),
          eq(commerceStorefrontCaseEscalations.owner_key, ownerKey),
        ),
      )
      .limit(1);
    if (!entry) throw new StorefrontAftercareError("escalation_not_found");

    return entry;
  };

  const claim = async (workerId: string, ownerKey?: string) => {
    const timestamp = now();
    const candidates = await options.db
      .select()
      .from(commerceStorefrontCaseEscalations)
      .where(
        and(
          inArray(commerceStorefrontCaseEscalations.status, [
            "open",
            "promoted",
          ]),
          lte(commerceStorefrontCaseEscalations.next_promotion_at, timestamp),
          or(
            isNull(commerceStorefrontCaseEscalations.lease_expires_at),
            lte(commerceStorefrontCaseEscalations.lease_expires_at, timestamp),
          ),
          ownerKey
            ? eq(commerceStorefrontCaseEscalations.owner_key, ownerKey)
            : undefined,
        ),
      )
      .orderBy(asc(commerceStorefrontCaseEscalations.next_promotion_at))
      .limit(DEFAULT_CYCLE_LIMIT);
    for (const candidate of candidates) {
      const [claimed] = await options.db
        .update(commerceStorefrontCaseEscalations)
        .set({
          lease_expires_at: new Date(timestamp.getTime() + leaseMs),
          updated_at: timestamp,
          worker_id: workerId,
        })
        .where(
          and(
            eq(commerceStorefrontCaseEscalations.id, candidate.id),
            eq(
              commerceStorefrontCaseEscalations.updated_at,
              candidate.updated_at,
            ),
            or(
              isNull(commerceStorefrontCaseEscalations.lease_expires_at),
              lte(
                commerceStorefrontCaseEscalations.lease_expires_at,
                timestamp,
              ),
            ),
          ),
        )
        .returning();
      if (claimed) return claimed;
    }

    return null;
  };

  const analytics = async (
    ownerKey?: string,
  ): Promise<StorefrontDisputeOutcomeAnalytics> => {
    const ownerFilter = ownerKey
      ? sql`AND cases.owner_key = ${ownerKey}`
      : sql``;
    const outcomeRows = await options.db.execute(sql`
      WITH evidence_cases AS (
        SELECT DISTINCT case_id
        FROM ${commerceStorefrontCaseEvidenceSubmissions}
        WHERE status IN ('staged', 'submitted')
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE cases.provider_status = 'won')::int AS won,
        COUNT(*) FILTER (WHERE cases.provider_status = 'lost')::int AS lost,
        COUNT(*) FILTER (WHERE cases.status NOT IN ('closed', 'rejected', 'resolved'))::int AS active,
        COUNT(*) FILTER (
          WHERE cases.status IN ('closed', 'rejected', 'resolved')
            AND cases.provider_status NOT IN ('won', 'lost')
        )::int AS other_terminal,
        COUNT(*) FILTER (WHERE cases.provider_status = 'won' AND evidence_cases.case_id IS NOT NULL)::int AS won_with_evidence,
        COUNT(*) FILTER (WHERE cases.provider_status = 'won' AND evidence_cases.case_id IS NULL)::int AS won_without_evidence,
        COUNT(*) FILTER (WHERE cases.provider_status = 'lost' AND evidence_cases.case_id IS NOT NULL)::int AS lost_with_evidence,
        COUNT(*) FILTER (WHERE cases.provider_status = 'lost' AND evidence_cases.case_id IS NULL)::int AS lost_without_evidence
      FROM ${commerceStorefrontCases} cases
      LEFT JOIN evidence_cases ON evidence_cases.case_id = cases.id
      WHERE cases.kind = 'dispute' ${ownerFilter}
    `);
    const acknowledgementRows = await options.db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
        COUNT(*) FILTER (WHERE status = 'open')::int AS open,
        COUNT(*) FILTER (WHERE status = 'promoted')::int AS promoted,
        AVG(EXTRACT(EPOCH FROM (acknowledged_at - created_at)) / 60)
          FILTER (WHERE acknowledged_at IS NOT NULL) AS average_minutes
      FROM ${commerceStorefrontCaseEscalations}
      WHERE true ${ownerKey ? sql`AND owner_key = ${ownerKey}` : sql``}
    `);
    const [outcomes] = Array.from(outcomeRows as unknown as OutcomeRow[]);
    const [acknowledgement] = Array.from(
      acknowledgementRows as unknown as AcknowledgementRow[],
    );

    return {
      acknowledgement: {
        acknowledged: count(acknowledgement!.acknowledged),
        averageMinutes:
          acknowledgement!.average_minutes === null
            ? null
            : count(acknowledgement!.average_minutes),
        open: count(acknowledgement!.open),
        promoted: count(acknowledgement!.promoted),
      },
      evidence: {
        lostWithEvidence: count(outcomes!.lost_with_evidence),
        lostWithoutEvidence: count(outcomes!.lost_without_evidence),
        wonWithEvidence: count(outcomes!.won_with_evidence),
        wonWithoutEvidence: count(outcomes!.won_without_evidence),
      },
      outcomes: {
        active: count(outcomes!.active),
        lost: count(outcomes!.lost),
        otherTerminal: count(outcomes!.other_terminal),
        total: count(outcomes!.total),
        won: count(outcomes!.won),
      },
    };
  };

  return {
    acknowledge: async (input: {
      actor: string;
      escalationId: string;
      ownerKey: string;
    }) => {
      const current = await escalationFor(input.ownerKey, input.escalationId);
      if (current.status === "acknowledged") return current;
      if (current.status === "resolved")
        throw new StorefrontAftercareError("escalation_conflict");
      const timestamp = now();
      const [acknowledged] = await options.db
        .update(commerceStorefrontCaseEscalations)
        .set({
          acknowledged_at: timestamp,
          acknowledged_by: input.actor,
          lease_expires_at: null,
          next_promotion_at: null,
          status: "acknowledged",
          updated_at: timestamp,
          worker_id: null,
        })
        .where(
          and(
            eq(commerceStorefrontCaseEscalations.id, current.id),
            eq(
              commerceStorefrontCaseEscalations.updated_at,
              current.updated_at,
            ),
          ),
        )
        .returning();
      if (!acknowledged)
        throw new StorefrontAftercareError("escalation_conflict");

      return acknowledged;
    },
    analytics,
    assign: async (input: {
      assignedTo: string | null;
      escalationId: string;
      ownerKey: string;
    }) => {
      const current = await escalationFor(input.ownerKey, input.escalationId);
      if (current.status === "resolved")
        throw new StorefrontAftercareError("escalation_conflict");
      const [assigned] = await options.db
        .update(commerceStorefrontCaseEscalations)
        .set({ assigned_to: input.assignedTo, updated_at: now() })
        .where(
          and(
            eq(commerceStorefrontCaseEscalations.id, current.id),
            eq(
              commerceStorefrontCaseEscalations.updated_at,
              current.updated_at,
            ),
          ),
        )
        .returning();
      if (!assigned) throw new StorefrontAftercareError("escalation_conflict");

      return assigned;
    },
    get: escalationFor,
    listFleet: () =>
      options.db
        .select()
        .from(commerceStorefrontCaseEscalations)
        .orderBy(desc(commerceStorefrontCaseEscalations.created_at)),
    listOwner: (ownerKey: string) =>
      options.db
        .select()
        .from(commerceStorefrontCaseEscalations)
        .where(eq(commerceStorefrontCaseEscalations.owner_key, ownerKey))
        .orderBy(desc(commerceStorefrontCaseEscalations.created_at)),
    runPromotionCycle: async (
      workerId: string,
      limit = DEFAULT_CYCLE_LIMIT,
      ownerKey?: string,
    ) => {
      if (!enabled) throw new StorefrontAftercareError("escalation_disabled");
      const results: Array<{
        escalationId: string;
        status: "promoted" | "retry";
      }> = [];
      for (let index = 0; index < limit; index += 1) {
        const escalation = await claim(workerId, ownerKey);
        if (!escalation) break;
        try {
          const incident = await options.promoteIncident({
            escalation,
            idempotencyKey: escalation.id,
          });
          await options.db
            .update(commerceStorefrontCaseEscalations)
            .set({
              incident_reference: incident.reference,
              last_error: null,
              lease_expires_at: null,
              next_promotion_at: null,
              promoted_at: now(),
              promotion_attempts: escalation.promotion_attempts + 1,
              status: "promoted",
              updated_at: now(),
              worker_id: null,
            })
            .where(eq(commerceStorefrontCaseEscalations.id, escalation.id));
          results.push({ escalationId: escalation.id, status: "promoted" });
        } catch (error) {
          await options.db
            .update(commerceStorefrontCaseEscalations)
            .set({
              last_error:
                error instanceof Error
                  ? error.message
                  : "Incident promotion failed",
              lease_expires_at: null,
              next_promotion_at: new Date(now().getTime() + retryMs),
              promotion_attempts: escalation.promotion_attempts + 1,
              updated_at: now(),
              worker_id: null,
            })
            .where(eq(commerceStorefrontCaseEscalations.id, escalation.id));
          results.push({ escalationId: escalation.id, status: "retry" });
        }
      }

      return results;
    },
  };
};
