/**
 * Phase D — PhysX scene + player CCT simulation off the main thread.
 * Slice 1: bootstrap scene/CCT; collider mirror + locomotion RPC follow in D2/D3.
 */
import { Layers } from '../physics/Layers'
import type { PhysxSimWorkerInbound, PhysxSimWorkerOutbound } from '../physics/physxSimTypes'

const ctx = self as unknown as DedicatedWorkerGlobalScope

const GROUND_BOX_HALF_EXTENT = 5000
const GROUND_BOX_HALF_HEIGHT = 0.5
const CONTROLLER_SLOPE_LIMIT_DEG = 45
const CONTROLLER_STEP_OFFSET = 0.45
const CONTROLLER_CONTACT_OFFSET = 0.08
const DEG2RAD = Math.PI / 180

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let physics: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let scene: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let defaultMaterial: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let controllerManager: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let controllerFilters: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let controller: any = null
let initPromise: Promise<void> | null = null
let nextId = 1
const pending = new Map<number, (msg: PhysxSimWorkerOutbound) => void>()

function post(msg: PhysxSimWorkerOutbound): void {
  ctx.postMessage(msg)
}

function reply(id: number, msg: PhysxSimWorkerOutbound): void {
  pending.delete(id)
  post(msg)
}

function fail(id: number, message: string): void {
  reply(id, { type: 'error', id, message })
}

function pxVec3(x: number, y: number, z: number): InstanceType<typeof PHYSX.PxVec3> {
  return new PHYSX.PxVec3(x, y, z)
}

function readControllerPosition(): [number, number, number] {
  if (!controller) return [0, 0, 0]
  const foot = controller.getFootPosition()
  return [foot.x, foot.y, foot.z]
}

async function ensureSim(): Promise<void> {
  if (scene) return
  if (!initPromise) {
    initPromise = (async () => {
      const { default: PhysXModule } = await import('../physics/vendor/physx-js-webidl.js')
      globalThis.PHYSX = await PhysXModule()
      const version = PHYSX.PHYSICS_VERSION
      const allocator = new PHYSX.PxDefaultAllocator()
      const errorCb = new PHYSX.PxDefaultErrorCallback()
      const foundation = PHYSX.CreateFoundation(version, allocator, errorCb)
      const tolerances = new PHYSX.PxTolerancesScale()
      physics = PHYSX.CreatePhysics(version, foundation, tolerances)
      PHYSX.PxTopLevelFunctions.prototype.InitExtensions(physics)
      defaultMaterial = physics.createMaterial(0.2, 0.2, 0.2)

      const sceneDesc = new PHYSX.PxSceneDesc(tolerances)
      sceneDesc.gravity = pxVec3(0, -9.81, 0)
      sceneDesc.cpuDispatcher = PHYSX.DefaultCpuDispatcherCreate(0)
      sceneDesc.filterShader = PHYSX.DefaultFilterShader()
      sceneDesc.flags.raise(PHYSX.PxSceneFlagEnum.eENABLE_CCD, true)
      sceneDesc.flags.raise(PHYSX.PxSceneFlagEnum.eENABLE_ACTIVE_ACTORS, true)
      sceneDesc.solverType = PHYSX.PxSolverTypeEnum.eTGS
      sceneDesc.broadPhaseType = PHYSX.PxBroadPhaseTypeEnum.eSAP
      scene = physics.createScene(sceneDesc)

      controllerManager = PHYSX.PxTopLevelFunctions.prototype.CreateControllerManager(scene)
      controllerFilters = new PHYSX.PxControllerFilters()
      controllerFilters.mFilterData = new PHYSX.PxFilterData(Layers.player.group, Layers.player.mask, 0, 0)
      controllerFilters.mFilterFlags = new PHYSX.PxQueryFlags(
        PHYSX.PxQueryFlagEnum.eSTATIC | PHYSX.PxQueryFlagEnum.eDYNAMIC
      )
      const cctFilterCallback = new PHYSX.PxControllerFilterCallbackImpl()
      cctFilterCallback.filter = () => true
      controllerFilters.mCCTFilterCallback = cctFilterCallback
      const filterCallback = new PHYSX.PxQueryFilterCallbackImpl()
      filterCallback.simplePreFilter = (queryFilterPtr: number, shapePtr: number) => {
        const queryFilter = PHYSX.wrapPointer(queryFilterPtr, PHYSX.PxQueryFilterData)
        const filterData = queryFilter.data
        const shape = PHYSX.wrapPointer(shapePtr, PHYSX.PxShape)
        const shapeFilterData = shape.getQueryFilterData()
        if (filterData.word0 & shapeFilterData.word1 && shapeFilterData.word0 & filterData.word1) {
          return PHYSX.PxQueryHitType.eBLOCK
        }
        return PHYSX.PxQueryHitType.eNONE
      }
      filterCallback.simplePostFilter = () => PHYSX.PxQueryHitType.eBLOCK
      controllerFilters.mFilterCallback = filterCallback

      const halfY = GROUND_BOX_HALF_HEIGHT
      const geometry = new PHYSX.PxBoxGeometry(GROUND_BOX_HALF_EXTENT, halfY, GROUND_BOX_HALF_EXTENT)
      const shapeFlags = new PHYSX.PxShapeFlags(
        PHYSX.PxShapeFlagEnum.eSCENE_QUERY_SHAPE | PHYSX.PxShapeFlagEnum.eSIMULATION_SHAPE
      )
      const shape = physics.createShape(geometry, defaultMaterial, true, shapeFlags)
      PHYSX.destroy(geometry)
      const filterData = new PHYSX.PxFilterData(Layers.environment.group, Layers.environment.mask, 0, 0)
      shape.setQueryFilterData(filterData)
      shape.setSimulationFilterData(filterData)
      const transform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity)
      transform.p = pxVec3(0, -halfY, 0)
      transform.q = new PHYSX.PxQuat(0, 0, 0, 1)
      const actor = physics.createRigidStatic(transform)
      actor.attachShape(shape)
      scene.addActor(actor)

      void allocator
      void errorCb
      void foundation
      void tolerances
    })()
  }
  await initPromise
}

function spawnPlayer(position: [number, number, number]): void {
  if (!physics || !scene || !controllerManager) throw new Error('PhysX sim worker not initialised')
  controller?.release()
  controller = null

  const radius = 0.3
  const capsuleHeight = 1.6
  const controllerHeight = capsuleHeight - radius * 2
  const desc = new PHYSX.PxCapsuleControllerDesc()
  desc.setToDefault()
  desc.height = controllerHeight
  desc.radius = radius
  desc.climbingMode = PHYSX.PxCapsuleClimbingModeEnum.eCONSTRAINED
  desc.slopeLimit = Math.cos(CONTROLLER_SLOPE_LIMIT_DEG * DEG2RAD)
  desc.stepOffset = CONTROLLER_STEP_OFFSET
  desc.contactOffset = CONTROLLER_CONTACT_OFFSET
  desc.material = defaultMaterial
  desc.upDirection = pxVec3(0, 1, 0)
  controller = controllerManager.createController(desc)
  PHYSX.destroy(desc)
  controller.setPosition(pxVec3(position[0], position[1], position[2]))
}

function movePlayer(
  displacement: [number, number, number],
  delta: number
): { grounded: boolean; position: [number, number, number] } {
  if (!controller || !scene) return { grounded: false, position: readControllerPosition() }
  const disp = pxVec3(displacement[0], displacement[1], displacement[2])
  const flags = controller.move(disp, 0, delta, controllerFilters)
  const grounded = flags.isSet(PHYSX.PxControllerCollisionFlagEnum.eCOLLISION_DOWN)
  scene.simulate(delta)
  scene.fetchResults(true)
  controllerManager?.computeInteractions(delta)
  return { grounded, position: readControllerPosition() }
}

async function handleMessage(msg: PhysxSimWorkerInbound): Promise<void> {
  const id = 'id' in msg ? msg.id : nextId++
  try {
    switch (msg.type) {
      case 'init': {
        await ensureSim()
        reply(msg.id, { type: 'init-done', id: msg.id })
        return
      }
      case 'spawn-player': {
        await ensureSim()
        spawnPlayer(msg.position)
        reply(msg.id, { type: 'spawn-done', id: msg.id })
        return
      }
      case 'move-player': {
        await ensureSim()
        const result = movePlayer(msg.displacement, msg.delta)
        reply(msg.id, {
          type: 'move-result',
          id: msg.id,
          position: result.position,
          grounded: result.grounded,
          groundPhysEntity: null
        })
        return
      }
      case 'teleport-player': {
        await ensureSim()
        if (controller) controller.setPosition(pxVec3(msg.position[0], msg.position[1], msg.position[2]))
        reply(msg.id, { type: 'move-result', id: msg.id, position: msg.position, grounded: true, groundPhysEntity: null })
        return
      }
      case 'register-collider-stream':
      case 'set-actor-pose':
        await ensureSim()
        // D2 — mirror boot colliders + runtime pose slides.
        reply(msg.id, msg.type === 'register-collider-stream' ? { type: 'register-done', id: msg.id, entity: msg.entity } : { type: 'pose-done', id: msg.id })
        return
      default:
        fail(id, `unknown message type`)
    }
  } catch (err) {
    fail(id, err instanceof Error ? err.message : String(err))
  }
}

ctx.onmessage = (ev: MessageEvent<PhysxSimWorkerInbound>) => {
  void handleMessage(ev.data)
}

post({ type: 'ready' })