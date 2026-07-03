/** Machine-readable ECS component registry — keep in sync with docs/INTEGRATION.md */

export type ComponentPhase = 1 | '1b' | 2 | 3 | 4 | 5 | 6
export type ComponentStatus = 'none' | 'stub' | 'partial' | 'render' | 'client-only'

export type EcsComponentEntry = {
  name: string
  coreId?: number
  phase: ComponentPhase
  status: ComponentStatus
  category: string
}

export const DCL_ECS_COMPONENTS: EcsComponentEntry[] = [
  { name: 'Transform', coreId: 1, phase: 1, status: 'render', category: 'core' },
  { name: 'Name', phase: 1, status: 'none', category: 'core' },
  { name: 'Tags', phase: 1, status: 'render', category: 'core' },
  { name: 'VisibilityComponent', coreId: 1081, phase: 1, status: 'render', category: 'core' },
  { name: 'GltfContainer', coreId: 1041, phase: 1, status: 'render', category: 'render' },
  { name: 'GltfContainerLoadingState', coreId: 1049, phase: '1b', status: 'none', category: 'render' },
  { name: 'MeshRenderer', coreId: 1018, phase: 1, status: 'render', category: 'render' },
  { name: 'Material', coreId: 1017, phase: 1, status: 'render', category: 'render' },
  { name: 'Animator', coreId: 1042, phase: '1b', status: 'render', category: 'render' },
  { name: 'Billboard', coreId: 1090, phase: '1b', status: 'render', category: 'render' },
  { name: 'LightSource', coreId: 1079, phase: '1b', status: 'render', category: 'render' },
  { name: 'TextShape', coreId: 1030, phase: '1b', status: 'render', category: 'render' },
  { name: 'SkyboxTime', coreId: 1210, phase: 3, status: 'render', category: 'environment' },
  { name: 'MeshCollider', coreId: 1019, phase: 2, status: 'render', category: 'physics' },
  { name: 'PhysicsCombinedForce', coreId: 1216, phase: 6, status: 'none', category: 'physics' },
  { name: 'PhysicsCombinedImpulse', coreId: 1215, phase: 6, status: 'none', category: 'physics' },
  { name: 'AvatarLocomotionSettings', coreId: 1211, phase: 2, status: 'render', category: 'physics' },
  { name: 'PointerLock', coreId: 1074, phase: 2, status: 'stub', category: 'input' },
  { name: 'InputModifier', coreId: 1078, phase: 3, status: 'render', category: 'input' },
  { name: 'MainCamera', coreId: 1075, phase: 2, status: 'client-only', category: 'camera' },
  { name: 'VirtualCamera', coreId: 1076, phase: 3, status: 'none', category: 'camera' },
  { name: 'CameraMode', coreId: 1072, phase: 4, status: 'none', category: 'camera' },
  { name: 'CameraModeArea', coreId: 1071, phase: 4, status: 'none', category: 'camera' },
  { name: 'PointerEvents', coreId: 1062, phase: 3, status: 'render', category: 'input' },
  { name: 'PointerEventsResult', coreId: 1063, phase: 3, status: 'client-only', category: 'input' },
  { name: 'PrimaryPointerInfo', coreId: 1209, phase: 3, status: 'client-only', category: 'input' },
  { name: 'Raycast', coreId: 1067, phase: 3, status: 'render', category: 'input' },
  { name: 'RaycastResult', coreId: 1068, phase: 3, status: 'client-only', category: 'input' },
  { name: 'TriggerArea', coreId: 1060, phase: 3, status: 'render', category: 'input' },
  { name: 'TriggerAreaResult', coreId: 1061, phase: 3, status: 'client-only', category: 'input' },
  { name: 'UiTransform', coreId: 1050, phase: 3, status: 'partial', category: 'ui' },
  { name: 'UiText', coreId: 1052, phase: 3, status: 'partial', category: 'ui' },
  { name: 'UiBackground', coreId: 1053, phase: 3, status: 'partial', category: 'ui' },
  { name: 'UiCanvasInformation', coreId: 1054, phase: 3, status: 'client-only', category: 'ui' },
  { name: 'UiInput', coreId: 1093, phase: 3, status: 'partial', category: 'ui' },
  { name: 'UiInputResult', coreId: 1095, phase: 3, status: 'client-only', category: 'ui' },
  { name: 'UiDropdown', coreId: 1094, phase: 3, status: 'partial', category: 'ui' },
  { name: 'UiDropdownResult', coreId: 1096, phase: 3, status: 'client-only', category: 'ui' },
  { name: 'AudioSource', coreId: 1020, phase: 3, status: 'render', category: 'media' },
  { name: 'AudioStream', coreId: 1021, phase: 3, status: 'render', category: 'media' },
  { name: 'AudioEvent', coreId: 1105, phase: 3, status: 'render', category: 'media' },
  { name: 'AudioAnalysis', coreId: 1212, phase: 3, status: 'client-only', category: 'media' },
  { name: 'VideoPlayer', coreId: 1043, phase: 3, status: 'render', category: 'media' },
  { name: 'VideoEvent', coreId: 1044, phase: 3, status: 'client-only', category: 'media' },
  { name: 'Tween', coreId: 1102, phase: 3, status: 'render', category: 'motion' },
  { name: 'TweenSequence', coreId: 1104, phase: 3, status: 'render', category: 'motion' },
  { name: 'TweenState', coreId: 1103, phase: 3, status: 'client-only', category: 'motion' },
  { name: 'AvatarShape', coreId: 1080, phase: 4, status: 'render', category: 'avatar' },
  { name: 'AvatarBase', coreId: 1087, phase: 4, status: 'none', category: 'avatar' },
  { name: 'AvatarAttach', coreId: 1073, phase: 4, status: 'render', category: 'avatar' },
  { name: 'AvatarEmoteCommand', coreId: 1088, phase: 4, status: 'render', category: 'avatar' },
  { name: 'AvatarEquippedData', coreId: 1091, phase: 4, status: 'client-only', category: 'avatar' },
  { name: 'AvatarModifierArea', coreId: 1070, phase: 4, status: 'none', category: 'avatar' },
  { name: 'PlayerIdentityData', coreId: 1089, phase: 4, status: 'client-only', category: 'avatar' },
  { name: 'NetworkEntity', phase: 5, status: 'stub', category: 'network' },
  { name: 'NetworkParent', phase: 5, status: 'stub', category: 'network' },
  { name: 'SyncComponents', phase: 5, status: 'none', category: 'network' },
  { name: 'AssetLoad', coreId: 1213, phase: 6, status: 'none', category: 'assets' },
  { name: 'AssetLoadLoadingState', coreId: 1214, phase: 6, status: 'client-only', category: 'assets' },
  { name: 'GltfNodeModifiers', coreId: 1099, phase: 6, status: 'none', category: 'render' },
  { name: 'NftShape', coreId: 1040, phase: 6, status: 'none', category: 'render' },
  { name: 'ParticleSystem', coreId: 1217, phase: 6, status: 'render', category: 'render' },
  { name: 'MapPin', coreId: 1097, phase: 6, status: 'none', category: 'misc' },
  { name: 'EngineInfo', coreId: 1048, phase: 6, status: 'client-only', category: 'misc' },
  { name: 'RealmInfo', coreId: 1106, phase: 6, status: 'client-only', category: 'misc' }
]

export const PHASE_1_COMPONENTS = DCL_ECS_COMPONENTS.filter((c) => c.phase === 1).map((c) => c.name)

export function componentsForPhase(maxPhase: number): EcsComponentEntry[] {
  const order = (p: ComponentPhase) => (p === '1b' ? 1.5 : p)
  return DCL_ECS_COMPONENTS.filter((c) => order(c.phase) <= maxPhase)
}
