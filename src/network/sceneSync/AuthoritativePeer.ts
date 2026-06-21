/**
 * Phase 5 authoritative peer election for serverless sync-systems scenes.
 * Matches Explorer behaviour: one peer runs server handlers (`EngineApi.isServer`).
 */

export class AuthoritativePeerRegistry {
  private localAddress: string | null = null
  private sceneRoomPeers = new Set<string>()
  private sceneRoomConnected = false

  setLocalAddress(address: string | null): void {
    this.localAddress = address?.toLowerCase() ?? null
  }

  setSceneRoomConnected(connected: boolean): void {
    this.sceneRoomConnected = connected
    if (!connected) this.sceneRoomPeers.clear()
  }

  trackSceneRoomPeerJoin(address: string): void {
    const key = address.toLowerCase()
    if (!key || key === this.localAddress) return
    this.sceneRoomPeers.add(key)
  }

  trackSceneRoomPeerLeave(address: string): void {
    this.sceneRoomPeers.delete(address.toLowerCase())
  }

  getSceneRoomPeerCount(): number {
    if (!this.sceneRoomConnected || !this.localAddress) return 0
    return this.sceneRoomPeers.size + 1
  }

  /**
   * True when this client should run authoritative server logic.
   * - Not connected to scene room → false
   * - Solo in scene room → true
   * - Multiple peers → lexicographically lowest address (deterministic)
   */
  isAuthoritativePeer(): boolean {
    if (!this.sceneRoomConnected || !this.localAddress) return false
    const peers = [this.localAddress, ...this.sceneRoomPeers]
    if (peers.length === 1) return true
    const sorted = [...peers].sort()
    return sorted[0] === this.localAddress
  }
}