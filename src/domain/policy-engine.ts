export interface AutoApprovalPolicySnapshot {
  effect: "auto_approve";
  requester_team_ids: number[];
  max_duration_minutes: number;
  reason_required: boolean;
}
