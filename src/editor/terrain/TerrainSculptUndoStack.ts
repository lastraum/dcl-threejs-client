export interface TerrainSculptSnapshot {
  heights: Float32Array
  splat: Uint8Array
  lava: Uint8Array
}

export class TerrainSculptUndoStack {
  private undoStack: TerrainSculptSnapshot[] = []
  private redoStack: TerrainSculptSnapshot[] = []

  constructor(private readonly maxDepth = 24) {}

  pushSnapshot(heights: Float32Array, splat: Uint8Array, lava: Uint8Array): void {
    this.undoStack.push({
      heights: new Float32Array(heights),
      splat: new Uint8Array(splat),
      lava: new Uint8Array(lava)
    })
    if (this.undoStack.length > this.maxDepth) this.undoStack.shift()
    this.redoStack.length = 0
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undo(current: TerrainSculptSnapshot): TerrainSculptSnapshot | null {
    if (!this.canUndo()) return null
    this.redoStack.push({
      heights: new Float32Array(current.heights),
      splat: new Uint8Array(current.splat),
      lava: new Uint8Array(current.lava)
    })
    return this.undoStack.pop()!
  }

  redo(current: TerrainSculptSnapshot): TerrainSculptSnapshot | null {
    if (!this.canRedo()) return null
    this.undoStack.push({
      heights: new Float32Array(current.heights),
      splat: new Uint8Array(current.splat),
      lava: new Uint8Array(current.lava)
    })
    return this.redoStack.pop()!
  }
}