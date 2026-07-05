import { describe, it, expect } from "vitest";
import { secureTokenEquals } from "../../src/security/secure-compare.js";

describe("Secure Token Comparison", () => {
  it("should return true for identical tokens", () => {
    const token = "a".repeat(32);
    expect(secureTokenEquals(token, token)).toBe(true);
  });

  it("should return false for different tokens of same length", () => {
    const token1 = "a".repeat(32);
    const token2 = "b".repeat(32);
    expect(secureTokenEquals(token1, token2)).toBe(false);
  });

  it("should return false for tokens of different lengths", () => {
    const token1 = "a".repeat(32);
    const token2 = "a".repeat(31);
    expect(secureTokenEquals(token1, token2)).toBe(false);
  });
});
