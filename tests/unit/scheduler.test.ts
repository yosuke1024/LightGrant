import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccessScheduler } from "../../src/services/scheduler.js";
import { ReconciliationService } from "../../src/services/reconciliation-service.js";

describe("AccessScheduler", () => {
  const mockReconciliationService = {
    reconcile: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReconciliationService;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should delegate tick to ReconciliationService", async () => {
    const scheduler = new AccessScheduler(mockReconciliationService);
    await scheduler.tick("2026-07-02T12:00:00Z");

    expect(mockReconciliationService.reconcile).toHaveBeenCalledWith(
      "2026-07-02T12:00:00Z",
    );
  });

  it("should prevent concurrent tick executions", async () => {
    let resolveReconcile: any;
    const slowReconcile = new Promise((resolve) => {
      resolveReconcile = resolve;
    });

    const mockSlowService = {
      reconcile: vi.fn().mockReturnValue(slowReconcile),
    } as unknown as ReconciliationService;

    const scheduler = new AccessScheduler(mockSlowService);

    // Start first tick
    const promise1 = scheduler.tick();

    // Start second tick immediately
    await scheduler.tick();

    // Finish first
    resolveReconcile();
    await promise1;

    // reconcile should only be called once because the second tick was skipped
    expect(mockSlowService.reconcile).toHaveBeenCalledTimes(1);
  });
});
