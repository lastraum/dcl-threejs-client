# DecentraCraft pointer law (−16,124)

**Source of truth:** catalyst scene entity for pointer `-16,124` → `bin/index.js`  
**Verified:** 2026-08-06 (re-fetch if scene timestamp/content hash changes)  
**Not source of truth:** chat history, “probably getClick”, untested comments

## Entity lookup

```bash
curl -sS "https://peer.decentraland.org/content/entities/scene?pointer=-16,124"
# content[] → file "bin/index.js" → hash →
curl -sS "https://peer.decentraland.org/content/contents/<hash>" -o /tmp/dc-index.js
```

## Law (minified names → role)

| Symbol | Role |
|--------|------|
| `x3` | `inputSystem` |
| `a0` | `PrimaryPointerInfo` component |
| `D` | `Transform` |
| `W` | engine |
| `iB` | press/drag/click controller (system) |
| `oB` / `Ud` | ground ray: Camera × PPI ∩ y=0 |
| `Qr` | UI chrome hit-test from screenCoordinates |
| `HS` | isPressOnSelectable via getInputCommand hit.entityId |
| `nQ` | onGroundClick: move selected units |
| `td` | green cylinder VFX (MeshRenderer + PBR α0.75 emissive 1.6) |

## Control flow

```text
every frame: iB(eQ)

isBlocked()? → clear press state; return
  (placing / rally / patrol / repair / match not playing, etc.)

isPressed(IA_POINTER):
  false → true:  # press down
    need screenCoordinates (mK); if Qr() UI chrome → ignore
    arm press; jT = HS(); Jr = oB() ground sample
  true → true:   # hold (box select drag threshold)
  true → false:  # release
    if box-drag → onBoxSelect
    else if !jT → onGroundClick(oB() ?? Jr)  # nQ
```

## Ground ray (oB / Ud) — client must feed

```text
ppi = PrimaryPointerInfo on RootEntity
cam = Transform on CameraEntity
ray = ppi.worldRayDirection
require ray.y < 0 (or |ray.y| > ε for Ud)
t = -cam.position.y / ray.y   # plane y = 0
ground.xz = cam.xz + ray.xz * t
```

**Client duty:** live CameraEntity pose (including VirtualCamera height) and live PPI on **every** engine update that runs this system — including pointer-edge ticks (not only play-frame-tick).

## Selectable (HS)

```text
entityId = getInputCommand(IA_POINTER, PET_DOWN)?.hit?.entityId
true if entityId matches a unit/building entity or colliderEntity
```

**Client duty:** empty ground PETs must use **hit.entityId = 0**, not PlayerEntity (1), so ground release is not treated as “started on selectable.”

## Move + VFX (nQ → td → kK)

```text
nQ(ground):
  selected = workers+soldiers from V.selectedUnitIds only
  if selected.length === 0 → return   # NO move, NO VFX
  # selecting a building sets selectedId but selectedUnitIds=[] → still no VFX
  issue move orders (+ network if multiplayer)
  td(ground)  # ensure cylinder entity; set QT + Au timer; entity may still be at (0,-10,0)

kK(dt):  # separate engine system
  if Au > 0: move disc to (QT.x, 0.2, QT.z), animate scale
  needs eng.update with systems running AFTER td in same or next sample
```

**Client duty:**
1. PET edges so `isPressed` arms/releases across frames (iB state machine).
2. Live CameraEntity + PPI on those frames (oB/Ud).
3. Real `dt` (not only `eng.update(0)`) so match-gated oQ and kK behave like Explorer.
4. After UP systems run, CRDT egress (pollEvents) so main peels MeshRenderer/Material/Transform.
5. Missing disc with ground ray OK often means: no worker/soldier selected, match not `active` (iB not called), or isBlocked — not invent a PE mesh.

## What is NOT the law

- `getClick(PlayerEntity)` for ground markers  
- Invented PE mesh under the cursor for empty board  
- Same-frame DOWN+UP “for getClick” as the primary design (press lifecycle is isPressed)  
- Scene-name special cases in the client  

## Platform mapping checklist

| Scene need | Platform surface |
|------------|------------------|
| isPressed / isTriggered / getInputCommand (no entity) | Inject PET_DOWN/UP into worker engine (PlayerEntity or any); buttonState global |
| Camera × PPI ray | applyPlayFrameReservedPoses / edge inject `camera` + `primaryPointer` |
| Empty ground hit.entityId | level-state inject hitEntity = 0 |
| td() MeshRenderer visible | worker CRDT egress after edge eng.update; material/depth peel (MARKER band) |
