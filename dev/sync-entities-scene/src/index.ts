/**
 * Minimal syncEntity conformance scene.
 *
 * Build: `npm i && npm run build` then load the world (two clients same realm).
 * Client: add `?syncdebug` to see CRDT / REQ / RES host logs.
 *
 * Shared enum id `1` → same network entity on every client (SDK networkId=0 path).
 */
import {
  engine,
  Entity,
  Material,
  MeshCollider,
  MeshRenderer,
  Transform,
  pointerEventsSystem,
  InputAction,
  PointerEventType
} from '@dcl/sdk/ecs'
import { Color4, Vector3 } from '@dcl/sdk/math'
import { ReactEcs, ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { syncEntity, isStateSyncronized } from '@dcl/sdk/network'

/** Shared network entity enum — same id on all clients. */
const SYNC_BOX_ENUM_ID = 1

let box: Entity
let status = 'boot'
let synced = false

function ui() {
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: 72,
        positionType: 'absolute',
        position: { bottom: 24, left: 0 },
        justifyContent: 'center',
        alignItems: 'center'
      }}
    >
      <UiEntity
        uiTransform={{
          width: 520,
          height: 64,
          padding: { left: 16, right: 16 },
          justifyContent: 'center',
          alignItems: 'center'
        }}
        uiBackground={{ color: Color4.create(0.05, 0.06, 0.1, 0.88) }}
      >
        <Label
          value={`SyncEntities · ${status} · isStateSyncronized=${synced ? 'true' : 'false'} · click box to nudge`}
          fontSize={14}
          color={Color4.White()}
          textAlign="middle-center"
        />
      </UiEntity>
    </UiEntity>
  )
}

function nudgeBox(): void {
  const t = Transform.getMutable(box)
  t.position.y = t.position.y > 1.5 ? 0.5 : 2.5
  status = `nudge y=${t.position.y.toFixed(1)}`
}

export function main() {
  ReactEcsRenderer.setUiRenderer(ui)

  box = engine.addEntity()
  Transform.create(box, {
    position: Vector3.create(8, 0.5, 8),
    scale: Vector3.create(1, 1, 1)
  })
  MeshRenderer.setBox(box)
  MeshCollider.setBox(box)
  Material.setPbrMaterial(box, {
    albedoColor: Color4.create(0.2, 0.75, 1, 1)
  })

  // Shared entity for all peers — Transform is the only component we sync.
  syncEntity(box, [Transform.componentId], SYNC_BOX_ENUM_ID)
  status = 'syncEntity registered'

  pointerEventsSystem.onPointerDown(
    {
      entity: box,
      opts: { button: InputAction.IA_POINTER, hoverText: 'Nudge (sync Transform)' }
    },
    () => {
      nudgeBox()
    }
  )

  engine.addSystem(() => {
    synced = isStateSyncronized()
  })
}
