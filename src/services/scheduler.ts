import { ReconciliationService } from "./reconciliation-service.js";
import { logger } from "../logger.js";

export class AccessScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private isTicking = false;

  constructor(private reconciliationService: ReconciliationService) {}

  /**
   * Start the scheduler background polling loop.
   */
  start(intervalMs = 30000): void {
    if (this.intervalId) {
      return;
    }
    logger.info(
      { intervalMs },
      "Starting AccessScheduler auto-revocation loop",
    );
    this.intervalId = setInterval(() => {
      this.tick().catch((err) => {
        logger.error({ err }, "Error in AccessScheduler loop tick");
      });
    }, intervalMs);
  }

  /**
   * Stop the scheduler loop.
   */
  stop(): void {
    if (this.intervalId) {
      logger.info("Stopping AccessScheduler loop");
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Trigger reconciliation synchronization.
   */
  async tick(nowStr?: string): Promise<void> {
    if (this.isTicking) {
      logger.warn("Scheduler tick skipped: previous tick still in progress");
      return;
    }

    this.isTicking = true;
    try {
      await this.reconciliationService.reconcile(nowStr);
    } finally {
      this.isTicking = false;
    }
  }
}
