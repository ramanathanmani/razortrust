/**
 * The audit vocabulary.
 *
 * Every state change that touches a mandate or money emits exactly one of
 * these. The list is closed on purpose: a reviewer should be able to read it
 * and know what the system can possibly do.
 */

export const AUDIT_EVENT_TYPES = [
  // Mandate lifecycle
  'mandate.drafted',
  'mandate.activated',
  'mandate.revoked',
  'mandate.expired',
  'mandate.exhausted',
  'mandate.verification_failed',

  // Intent + quote
  'intent.created',
  'quote.submitted',
  'quote.ai_structured',
  'quote.ai_rejected',

  // The decision
  'drift.evaluated',
  'drift.blocked',

  // Money
  'authorization.requested',
  'authorization.succeeded',
  'authorization.failed',
  'capture.deadline_check_failed',
  'capture.requested',
  'capture.succeeded',
  'capture.failed',
  'authorization.release_requested',
  'authorization.released',
  'authorization.auto_refunded_by_gateway',

  // Post-delivery
  'delivery.recorded',
  'settlement.evaluated',
  'refund.requested',
  'refund.succeeded',
  'refund.failed',

  // Infrastructure
  'webhook.received',
  'webhook.replay_rejected',
  'audit.checkpoint_created',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const ACTOR_TYPES = ['human', 'agent', 'system', 'gateway'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Everything the chain hashes for a single entry. */
export interface AuditEventInput {
  readonly tenantId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly eventType: AuditEventType;
  readonly mandateId?: string;
  readonly intentId?: string;
  /** Structured detail. Must be canonicalizable: no floats, no undefined. */
  readonly payload: Record<string, unknown>;
  readonly occurredAt: string;
}

/** A persisted entry: the input plus its position and hash linkage. */
export interface AuditEvent extends AuditEventInput {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
}
