-- Migration: Revoke Lease
-- Adds a lease taken when a grant enters 'revoking', so a revocation
-- interrupted by a crash can be reclaimed instead of stranding the grant.
--
-- The lease has two parts:
--   * revoking_started_at — when the lease was taken, for staleness.
--   * revoking_lease_id    — a unique fencing token identifying the run that
--     currently owns the revocation. A worker that loses its lease (a later
--     worker reclaims the stale grant under a fresh token) can no longer match
--     this id, so its destructive GitHub call and terminal DB write are fenced
--     out. Without it, revoking_started_at alone cannot tell a live owner from
--     a returning zombie that once held the same stale timestamp window.

ALTER TABLE grants ADD COLUMN revoking_started_at TEXT NULL;
ALTER TABLE grants ADD COLUMN revoking_lease_id TEXT NULL;

CREATE INDEX idx_grants_revoking_lease ON grants(status, revoking_started_at);

-- Grants already parked in 'revoking' predate the lease and hold no live
-- claim: no process is still working on them. Stamp them with their last
-- update so the ordinary staleness rule sweeps them up. They carry no lease
-- id, which the staleness rule also treats as reclaimable.
UPDATE grants
SET revoking_started_at = updated_at
WHERE status = 'revoking' AND revoking_started_at IS NULL;
