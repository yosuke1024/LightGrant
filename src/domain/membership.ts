export type MembershipMutationState =
  | "not_started"
  | "add_intent_recorded"
  | "add_request_sent"
  | "membership_confirmed"
  | "reactivation_required";

export function determineMembershipOrigin(params: {
  mutationState: string;
  membershipCreatedByApp: boolean;
  observedRole: "member" | "maintainer";
}): "preexisting" | "app_created" {
  if (
    params.mutationState === "not_started" &&
    !params.membershipCreatedByApp
  ) {
    return "preexisting";
  }

  return "app_created";
}
