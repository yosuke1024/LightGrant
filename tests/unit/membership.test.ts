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

  it("should return app_created when mutation state is add_intent_recorded", () => {
    const result = determineMembershipOrigin({
      mutationState: "add_intent_recorded",
      membershipCreatedByApp: false,
      observedRole: "member",
    });
    expect(result).toBe("app_created");
  });

  it("should return app_created when membership was already created by app", () => {
    const result = determineMembershipOrigin({
      mutationState: "not_started",
      membershipCreatedByApp: true,
      observedRole: "member",
    });
    expect(result).toBe("app_created");
  });

  it("should return app_created when mutation state is membership_confirmed", () => {
    const result = determineMembershipOrigin({
      mutationState: "membership_confirmed",
      membershipCreatedByApp: false,
      observedRole: "maintainer",
    });
    expect(result).toBe("app_created");
  });
});
