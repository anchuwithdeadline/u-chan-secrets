/** Blocks after `max` consecutive failures until `windowMs` has passed since the last one. */
export class AttemptLimiter {
  private count = 0
  private last = 0

  constructor(private readonly max = 5, private readonly windowMs = 900000, private readonly now = Date.now) {}

  blocked(): boolean {
    if (this.count < this.max) return false
    if (this.now() - this.last >= this.windowMs) {
      this.count = 0
      return false
    }
    return true
  }

  fail(): void {
    this.count++
    this.last = this.now()
  }

  reset(): void {
    this.count = 0
  }
}
