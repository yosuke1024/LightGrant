export type MembershipMutationState =
  | "not_started"
  | "add_intent_recorded"
  | "add_request_sent"
  | "membership_confirmed"
  | "reactivation_required";

/**
 * Decide whether an observed membership predates LightGrant.
 *
 * The decision rests solely on membershipCreatedByApp, which is recorded once
 * from live GitHub state when the grant is first processed and never promoted
 * afterwards. mutationState is deliberately not consulted: it advances past
 * "not_started" on every path that reaches this function (reactivation,
 * membership_confirmed, add_request_sent), so gating on it made "preexisting"
 * unreachable and silently disabled removal protection for permanent members.
 */
export function determineMembershipOrigin(params: {
  mutationState: string;
  membershipCreatedByApp: boolean;
  observedRole: "member" | "maintainer";
}): "preexisting" | "app_created" {
  if (!params.membershipCreatedByApp) {
    return "preexisting";
  }

  return "app_created";
}
