/**
 * Archava Operation Controller & Lock Manager.
 *
 * Coordinates asynchronous Web3 mutations (checkout, faucet, session preparation)
 * with deterministic lock ownership and network preparation separation.
 *
 * Guarantees:
 * 1. An explicit network switch during preparation does not lock the subsequent transaction.
 * 2. Only the operation that owns the active lock can release it (no old operation releasing a new lock).
 * 3. Unexpected network/account changes invalidate in-flight operations.
 * 4. Cancellation or errors always release lock ownership cleanly.
 */

export type OperationKind = "buy" | "faucet" | "session" | "preview";

export interface OperationLock {
  readonly id: string;
  readonly kind: OperationKind;
  readonly epoch: number;
  readonly wallet: string;
  isActive(): boolean;
  release(): boolean;
}

export class OperationController {
  private currentLock: OperationLock | null = null;
  private epoch = 0;
  private nextOpId = 1;

  getEpoch(): number {
    return this.epoch;
  }

  /**
   * Invalidates any active epoch due to unexpected chain or account changes.
   */
  invalidate(_reason?: string): void {
    this.epoch++;
  }

  /**
   * Returns true if any operation currently holds the transacting mutex lock.
   */
  isLocked(): boolean {
    return this.currentLock !== null;
  }

  getCurrentLock(): OperationLock | null {
    return this.currentLock;
  }

  /**
   * Acquires the operation lock for a specific kind and wallet.
   * Captures the current epoch AFTER preparation has finished.
   * Returns null if another operation already holds the lock.
   */
  acquire(kind: OperationKind, wallet: string): OperationLock | null {
    if (this.currentLock) {
      return null;
    }

    const id = `op_${this.nextOpId++}_${Date.now()}`;
    const capturedEpoch = this.epoch;
    const normalizedWallet = wallet.toLowerCase();

    const lock: OperationLock = {
      id,
      kind,
      epoch: capturedEpoch,
      wallet: normalizedWallet,
      isActive: () => {
        return (
          this.currentLock !== null &&
          this.currentLock.id === id &&
          this.epoch === capturedEpoch
        );
      },
      release: () => {
        if (this.currentLock && this.currentLock.id === id) {
          this.currentLock = null;
          return true;
        }
        return false;
      },
    };

    this.currentLock = lock;
    return lock;
  }

  /**
   * Releases lock by identity token or string ID.
   * Does NOT release if the active lock belongs to a different operation.
   */
  release(lockOrId: OperationLock | string): boolean {
    const id = typeof lockOrId === "string" ? lockOrId : lockOrId.id;
    if (this.currentLock && this.currentLock.id === id) {
      this.currentLock = null;
      return true;
    }
    return false;
  }

  /**
   * Force reset for test suites.
   */
  reset(): void {
    this.currentLock = null;
    this.epoch = 0;
    this.nextOpId = 1;
  }
}

export const operationController = new OperationController();
