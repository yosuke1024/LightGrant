-- Migration: Revoke Lease
-- Adds a lease stamp taken when a grant enters 'revoking', so a revocation
-- interrupted by a crash can be reclaimed instead of stranding the grant.

ALTER TABLE grants ADD COLUMN revoking_started_at TEXT NULL;

CREATE INDEX idx_grants_revoking_lease ON grants(status, revoking_started_at);

-- Grants already parked in 'revoking' predate the lease and hold no live
-- claim: no process is still working on them. Stamp them with their last
-- update so the ordinary staleness rule sweeps them up.
UPDATE grants
SET revoking_started_at = updated_at
WHERE status = 'revoking' AND revoking_started_at IS NULL;
