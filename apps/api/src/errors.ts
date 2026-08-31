/**
 * Error shapes.
 *
 * A blocked payment is not a server error, and it is not a generic 400 either.
 * It is a decision, and the agent needs to be able to tell it apart from a
 * malformed request — one means "fix your payload", the other means "the human
 * did not approve this". They get different status codes and different bodies.
 */
import type { DriftViolation, MandateFailure } from '@razortrust/core';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, detail?: unknown) =>
  new ApiError(400, 'BAD_REQUEST', message, detail);

export const unauthorized = (message = 'Missing or invalid API key') =>
  new ApiError(401, 'UNAUTHORIZED', message);

export const forbidden = (message: string, detail?: unknown) =>
  new ApiError(403, 'FORBIDDEN', message, detail);

export const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);

export const conflict = (message: string, detail?: unknown) =>
  new ApiError(409, 'CONFLICT', message, detail);

/**
 * 422: the request was well-formed and the mandate is real, but the rules said
 * no. The violations are returned in full — an agent platform needs to be able
 * to show its user exactly which term was breached.
 */
export const blockedByDrift = (violations: readonly DriftViolation[]) =>
  new ApiError(422, 'BLOCKED_BY_DRIFT', 'Quote does not match the mandate; payment blocked', {
    violations,
  });

export const mandateRejected = (failures: readonly MandateFailure[]) =>
  new ApiError(403, 'MANDATE_REJECTED', 'Mandate is not valid for this request', { failures });
