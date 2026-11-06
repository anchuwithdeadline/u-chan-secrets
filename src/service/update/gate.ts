const safeMethods = new Set(['capabilities', 'diagnose', 'audit', 'plan_update', 'begin_update', 'update_status', 'activate_update', 'confirm_update_ready'])
/** One admission boundary covers grants, unlock prompts and management windows over authenticated IPC. */
export class UpdateGate {
  private active = 0
  blocked = false
  enter(method: string): (() => void) | null {
    if (safeMethods.has(method)) return () => {}
    if (this.blocked) return null
    this.active++
    let left = false
    return () => { if (!left) { left = true; this.active-- } }
  }
  tryPause(): boolean { if (this.active || this.blocked) return false; this.blocked = true; return true }
  resume(): void { this.blocked = false }
}
