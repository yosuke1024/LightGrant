-- Migration: Grant Reactivation Support
-- The 'reactivation_required' state is handled at the application logic layer.
-- No schema adjustments needed for the grants table as status constraints are not enforced at database level.
SELECT 1;
