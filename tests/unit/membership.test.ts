import { describe, it, expect } from "vitest";
import { determineMembershipOrigin } from "../../src/domain/membership.js";

describe("determineMembershipOrigin", () => {
  it("should return preexisting when mutation state is not_started and not created by app", () => {
    const result = determineMembershipOrigin({
      mutationState: "not_started",
      membershipCreatedByApp: false,
      observedRole: "member",
    });
    expect(result).toBe("preexisting");
  });

  it("should return preexisting when observed role is maintainer and not created by app", () => {
    const result = determineMembershipOrigin({
      mutationState: "not_started",
      membershipCreatedByApp: false,
      observedRole: "maintainer",
    });
    expect(result).toBe("preexisting");
  });

  it("should return app_created when membership was already created by app", () => {
    const result = determineMembershipOrigin({
      mutationState: "not_started",
      membershipCreatedByApp: true,
      observedRole: "member",
    });
    expect(result).toBe("app_created");
  });

  it("should return app_created regardless of how far mutation state has advanced", () => {
    for (const mutationState of [
      "add_intent_recorded",
      "add_request_sent",
      "membership_confirmed",
      "reactivation_required",
    ]) {
      const result = determineMembershipOrigin({
        mutationState,
        membershipCreatedByApp: true,
        observedRole: "member",
      });
      expect(result).toBe("app_created");
    }
  });

  // A grant is only ever seeded with membership_created_by_app = 1
  // (GrantService), so the flag drops to 0 exclusively when the app observed a
  // membership it did not create. mutation_state advancing past not_started
  // therefore says nothing about origin, and must not override the flag: doing
  // so is what previously exposed permanent members to automatic removal.
  it("should keep reporting preexisting once mutation state advances", () => {
    for (const mutationState of [
      "add_intent_recorded",
      "add_request_sent",
      "membership_confirmed",
      "reactivation_required",
    ]) {
      const result = determineMembershipOrigin({
        mutationState,
        membershipCreatedByApp: false,
        observedRole: "maintainer",
      });
      expect(result).toBe("preexisting");
    }
  });
});
