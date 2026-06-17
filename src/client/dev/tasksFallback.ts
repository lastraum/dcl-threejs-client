/** Auto-generated from docs/TASKS.yaml by scripts/sync-dev-progress.mjs — do not edit manually. */

import type { TasksRegistry } from './tasksRegistry'

export const TASKS_FALLBACK: TasksRegistry = {
  "schema_version": 1,
  "updated": "2026-06-17",
  "tasks": [
    {
      "id": "rearch-e7-pointer-same-tick",
      "title": "Re-arch e7 — pointer same-tick gate via crdt-response",
      "status": "done",
      "owner": "maintainer",
      "track": "re-arch",
      "phase": 3,
      "complexity": "high",
      "priority": "P0",
      "dependencies": [
        "rearch-e6-boot-snapshot"
      ],
      "blocks": [
        "rearch-e8-delete-push-channel"
      ],
      "files": [
        "src/core/systems/SceneScriptSystem.ts",
        "src/input/PointerEventsSystem.ts",
        "src/shim/worker/sceneWorker.ts",
        "src/shim/types.ts"
      ],
      "acceptance_criteria": [
        "PointerEventsResult delivered same tick on asset-pack Trigger scenes",
        "getClick() reads result before scene inputSystem runs",
        "No regression on Genesis Plaza / pizzaparty.dcl.eth click flows"
      ],
      "ai_context_links": [
        "docs/INTEGRATION.md",
        "docs/PROGRESS.md"
      ],
      "test_scenes": [
        "genesis-city",
        "pizzaparty.dcl.eth",
        "rickroll.dcl.eth"
      ],
      "do_not_touch": [
        "src/shim/system/createSystemStubs.ts"
      ],
      "notes": "Default path (2026-06-16): encoder source-capture + pointerResponseStash + crdt-round-trip-nudge merges PointerEventsResult on empty crdt-response. Legacy crdt-renderer-push removed in e8. Fix 2026-06-16: stash only consumed on nudge (empty body); nudge runs engine.update(0) after stub apply; mirror flushOutgoing fallback when encoder encode is empty. Re-validate: Genesis watering plants, RickRoll F-key, asset-pack Triggers. Debug: ?pointerverbose.",
      "maintainer_only": true
    },
    {
      "id": "rearch-e8-delete-push-channel",
      "title": "Re-arch e8 — delete crdt-renderer-push / stash / nudge",
      "status": "done",
      "owner": "maintainer",
      "track": "re-arch",
      "phase": 3,
      "complexity": "high",
      "priority": "P0",
      "dependencies": [
        "rearch-e7-pointer-same-tick"
      ],
      "blocks": [
        "rearch-e9-drop-mirror-engine"
      ],
      "files": [
        "src/core/systems/SceneScriptSystem.ts",
        "src/shim/worker/sceneWorker.ts",
        "src/shim/types.ts"
      ],
      "acceptance_criteria": [
        "crdt-renderer-push* message types removed from worker protocol",
        "rendererPushStash / schedulePointerStashNudge deleted",
        "Same-tick pointer delivery still passes QA"
      ],
      "ai_context_links": [
        "docs/INTEGRATION.md"
      ],
      "test_scenes": [
        "genesis-city"
      ],
      "do_not_touch": [
        "src/bridge/CrdtMirror.ts"
      ],
      "notes": "Shipped 2026-06-16 — deleted crdt-renderer-push/ack, rendererPushQueue, deliverRendererInbound, rendererPushStash machinery. crdt-round-trip-nudge retained for same-tick pointer delivery.",
      "maintainer_only": true
    },
    {
      "id": "rearch-e9-drop-mirror-engine",
      "title": "Re-arch e9 — projection-only reads, drop CrdtMirror Engine()",
      "status": "done",
      "owner": "maintainer",
      "track": "re-arch",
      "phase": 3,
      "complexity": "high",
      "priority": "P0",
      "dependencies": [
        "rearch-e8-delete-push-channel"
      ],
      "blocks": [
        "rearch-e10-perf-pass"
      ],
      "files": [
        "src/bridge/CrdtMirror.ts",
        "src/bridge/CrdtProjection.ts",
        "src/bridge/ProjectionView.ts",
        "src/bridge/CrdtEncoder.ts",
        "src/core/systems/SceneScriptSystem.ts"
      ],
      "acceptance_criteria": [
        "All scene-render bridges read via ProjectionView",
        "getState bootstrap uses projection dump, not mirror engine",
        "Encoder is sole outbound writer on audited ticks"
      ],
      "ai_context_links": [
        "docs/INTEGRATION.md"
      ],
      "test_scenes": [
        "genesis-city",
        "rickroll.dcl.eth"
      ],
      "do_not_touch": [
        "src/shim/worker/sceneWorker.ts"
      ],
      "notes": "Shipped 2026-06-17 — CrdtMirror.ts deleted; RendererComponentHost schema-only Engine (component defs + NetworkEntity/NetworkParent, no CRDT transports/update). Bootstrap getState via projection dump.",
      "maintainer_only": true
    },
    {
      "id": "rearch-phase4-entity-store",
      "title": "Phase 4 — Three.js-backed EntityStore (unify projection + scene graph)",
      "status": "done",
      "owner": "maintainer",
      "track": "re-arch",
      "phase": 4,
      "complexity": "high",
      "priority": "P0",
      "dependencies": [
        "rearch-e9-drop-mirror-engine"
      ],
      "blocks": [],
      "files": [
        "src/bridge/EntityStore.ts",
        "src/bridge/ThreeBridge.ts",
        "src/bridge/CrdtProjection.ts",
        "src/core/systems/SceneScriptSystem.ts"
      ],
      "acceptance_criteria": [
        "EntityStore owns all scene entity THREE.Group nodes",
        "Transform CRDT apply mutates groups in place (no duplicate projection map for Transform)",
        "Mesh/collider/pointer secondary systems subscribe to EntityStore change notifications",
        "Full-walk sync reuses applySceneDiff (single transform/visibility/light path)",
        "Animator/AvatarShape async bridges driven by store notifications, not foldProjectionChanges",
        "Genesis Plaza renders + clicks identical to pre-Phase-4"
      ],
      "ai_context_links": [
        "docs/INTEGRATION.md"
      ],
      "test_scenes": [
        "genesis-city",
        "rickroll.dcl.eth"
      ],
      "notes": "2026-06-17 — EntityStore scaffold + ThreeBridge node migration. Slice 1: Transform apply. Slice 2: mesh/collider/pointer store subscriptions. Slice 3: full-walk via applySceneDiff; bridgeDirty via store. Slice 4: store-backed hydration stats + owner guards on teardown. Slice 5: RemoteAvatarManager upsertAvatar (owner avatar). e10 full-resync tuning deferred.",
      "maintainer_only": true
    },
    {
      "id": "rearch-e6-boot-snapshot",
      "title": "Re-arch e6 — getState boot-snapshot parity oracle",
      "status": "done",
      "owner": "maintainer",
      "track": "re-arch",
      "phase": 3,
      "complexity": "high",
      "priority": "P0",
      "dependencies": [],
      "blocks": [
        "rearch-e7-pointer-same-tick"
      ],
      "files": [
        "src/bridge/CrdtMirror.ts",
        "src/bridge/CrdtProjection.ts",
        "src/core/systems/SceneScriptSystem.ts"
      ],
      "acceptance_criteria": [
        "Projection parity OK on composite boot snapshot",
        "CrdtMirror.getState remains bootstrap source until e9"
      ],
      "notes": "Shipped 2026-06-16 — see PROGRESS.md milestone.",
      "maintainer_only": true
    },
    {
      "id": "pointer-events-qa",
      "title": "PointerEvents manual QA harness",
      "status": "done",
      "owner": "maintainer",
      "track": "input",
      "phase": 3,
      "complexity": "low",
      "priority": "P2",
      "dependencies": [],
      "blocks": [],
      "files": [
        "src/input/PointerEventsSystem.ts"
      ],
      "acceptance_criteria": [
        "Custom scenes + Genesis interactives validated"
      ],
      "notes": "Shipped — hover, click, key actions validated."
    },
    {
      "id": "engine-api-comms",
      "title": "EngineApi sendBatch + subscribe (comms topic)",
      "status": "done",
      "owner": "maintainer",
      "track": "ecs-shim",
      "phase": 1,
      "complexity": "medium",
      "priority": "P0",
      "dependencies": [],
      "blocks": [],
      "files": [
        "src/shim/system/createSystemStubs.ts",
        "src/shim/worker/sceneWorker.ts"
      ],
      "acceptance_criteria": [
        "comms topic → onCommsMessage observable in scene worker"
      ],
      "notes": "SDK7 parity — paired sendBatch + subscribe."
    },
    {
      "id": "tags-component",
      "title": "Tags component — getEntitiesByTag()",
      "status": "done",
      "owner": "maintainer",
      "track": "ecs",
      "phase": 1,
      "complexity": "low",
      "priority": "P1",
      "dependencies": [],
      "blocks": [],
      "files": [
        "src/bridge/mirrorComponents.ts"
      ],
      "acceptance_criteria": [
        "Mirror CRDT sync for core-schema::Tags"
      ],
      "notes": "Shipped."
    },
    {
      "id": "signed-fetch-bridge",
      "title": "SignedFetch scene worker RPC",
      "status": "done",
      "owner": "maintainer",
      "track": "ecs-shim",
      "phase": 3,
      "complexity": "medium",
      "priority": "P1",
      "dependencies": [],
      "blocks": [],
      "files": [
        "src/shim/system/createSystemStubs.ts"
      ],
      "acceptance_criteria": [
        "signedFetch + getHeaders via worker RPC → decentraland-crypto-fetch"
      ],
      "notes": "Shipped — ADR-44 signed HTTP + WebSocket auth headers."
    },
    {
      "id": "chat-nav-links",
      "title": "Chat nav links → teleport",
      "status": "done",
      "owner": "maintainer",
      "track": "social",
      "phase": 5,
      "complexity": "medium",
      "priority": "P2",
      "dependencies": [],
      "blocks": [],
      "files": [
        "src/social/linkifyText.ts",
        "src/client/AppController.ts"
      ],
      "acceptance_criteria": [
        "Coords, .dcl.eth, play URLs teleport correctly"
      ],
      "notes": "Shipped."
    },
    {
      "id": "chat-timestamp-parity",
      "title": "Explorer chat timestamp wire parity",
      "status": "partial",
      "owner": "unassigned",
      "track": "social",
      "phase": 5,
      "complexity": "low",
      "priority": "P3",
      "dependencies": [],
      "blocks": [],
      "files": [
        "src/social/dclRfc4Chat.ts",
        "src/client/ui/shell/"
      ],
      "acceptance_criteria": [
        "Incoming chat timestamps match Explorer display"
      ],
      "notes": "Our UI correct; Unity shows wrong dates on wire — investigate RFC4 Chat.timestamp semantics."
    },
    {
      "id": "pointer-collider-checker-noise",
      "title": "SDK pointer-event-collider-checker false positives (asset-pack Triggers)",
      "status": "done",
      "owner": "unassigned",
      "track": "input",
      "phase": 3,
      "complexity": "low",
      "priority": "P3",
      "dependencies": [],
      "blocks": [],
      "files": [
        "src/shim/worker/sceneWorker.ts",
        "src/input/PointerEventsSystem.ts"
      ],
      "acceptance_criteria": [
        "No repeated Missing MeshCollider worker logs on rickroll.dcl.eth asset-pack Trigger scenes",
        "Pointer click delivery unchanged on Trigger + GLTF _collider layouts"
      ],
      "ai_context_links": [
        "docs/PROGRESS.md"
      ],
      "test_scenes": [
        "rickroll.dcl.eth"
      ],
      "notes": "@dcl/ecs pointerEventColliderChecker (scene worker) warns once per entity when PointerEvents lacks MeshCollider on the same entity; it skips GltfContainer on that entity only, not children. ThreejsClient collectPointerTargets already raycasts GLTF _collider meshes, MeshCollider, and MeshRenderer; resolvePointerResultEntity walks parents for asset-pack Triggers. Warnings are benign — clicks work. Optional fix filter worker console or upstream SDK child GltfContainer check.\n"
    },
    {
      "id": "tween-sequence-qa",
      "title": "TweenSequence yoyo/restart QA",
      "status": "done",
      "owner": "maintainer",
      "track": "ecs",
      "phase": 3,
      "complexity": "low",
      "priority": "P2",
      "dependencies": [],
      "blocks": [],
      "files": [
        "src/bridge/TweenBridge.ts"
      ],
      "acceptance_criteria": [
        "Genesis Plaza blimp orbit — rotate Tween + TweenSequence"
      ],
      "notes": "Shipped with pumpMotionBridges fix."
    }
  ]
} as TasksRegistry
