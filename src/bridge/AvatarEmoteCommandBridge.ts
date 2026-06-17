import type { Entity } from '@dcl/ecs'
import type { PBAvatarEmoteCommand } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/avatar_emote_command.gen'
import type { AvatarShapeBridge } from './AvatarShapeBridge'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'

type EmoteCommandState = {
  /** Highest `timestamp` already consumed from the grow-only set. */
  lastProcessedTimestamp: number
}

export type AvatarEmoteHandler = {
  play: (emoteUrn: string, loop: boolean) => boolean
  stop: () => void
}

type EmoteAction = { type: 'play'; emoteUrn: string; loop: boolean } | { type: 'stop' }

function emoteActionFromCommand(cmd: PBAvatarEmoteCommand): EmoteAction {
  const emoteUrn = cmd.emoteUrn?.trim() ?? ''
  if (!emoteUrn) return { type: 'stop' }
  return { type: 'play', emoteUrn, loop: cmd.loop ?? false }
}

/** ECS `AvatarEmoteCommand` → local player or AvatarShape NPC emote playback. */
export class AvatarEmoteCommandBridge {
  private readonly state = new Map<Entity, EmoteCommandState>()
  private playerHandler: AvatarEmoteHandler | null = null

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly avatarShapes: AvatarShapeBridge
  ) {}

  setPlayerHandler(handler: AvatarEmoteHandler | null): void {
    this.playerHandler = handler
  }

  sync(view: ProjectionView): void {
    const { AvatarEmoteCommand } = this.ecs
    const active = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(AvatarEmoteCommand)) {
      if (entity === view.RootEntity || entity === view.CameraEntity) continue
      active.add(entity)

      let entry = this.state.get(entity)
      if (!entry) {
        entry = { lastProcessedTimestamp: -1 }
        this.state.set(entity, entry)
      }

      const pending = [...AvatarEmoteCommand.get(entity)].sort(
        (a, b) => a.timestamp - b.timestamp
      )
      for (const cmd of pending) {
        if (cmd.timestamp <= entry.lastProcessedTimestamp) continue
        entry.lastProcessedTimestamp = cmd.timestamp
        const action = emoteActionFromCommand(cmd)

        if (entity === view.PlayerEntity) {
          if (action.type === 'play') {
            this.playerHandler?.play(action.emoteUrn, action.loop)
          } else {
            this.playerHandler?.stop()
          }
          continue
        }

        if (action.type === 'play') {
          this.avatarShapes.playEmote(entity, action.emoteUrn, action.loop)
        } else {
          this.avatarShapes.stopEmote(entity)
        }
      }
    }

    for (const entity of this.state.keys()) {
      if (!active.has(entity)) this.state.delete(entity)
    }
  }
}
