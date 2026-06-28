import * as extended from '@dcl/ecs/dist/components'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import type { IEngine } from '@dcl/ecs'

/** Renderer-side component defs bound to the mirror engine (not the scene singleton). */
export type MirrorComponents = {
  Transform: ReturnType<typeof extended.Transform>
  Tags: ReturnType<typeof extended.Tags>
  MeshRenderer: ReturnType<typeof extended.MeshRenderer>
  MeshCollider: ReturnType<typeof extended.MeshCollider>
  Material: ReturnType<typeof extended.Material>
  GltfContainer: ReturnType<typeof generated.GltfContainer>
  VisibilityComponent: ReturnType<typeof generated.VisibilityComponent>
  LightSource: ReturnType<typeof generated.LightSource>
  TextShape: ReturnType<typeof generated.TextShape>
  Billboard: ReturnType<typeof generated.Billboard>
  Animator: ReturnType<typeof generated.Animator>
  MainCamera: ReturnType<typeof generated.MainCamera>
  AvatarLocomotionSettings: ReturnType<typeof generated.AvatarLocomotionSettings>
  InputModifier: ReturnType<typeof generated.InputModifier>
  AvatarShape: ReturnType<typeof generated.AvatarShape>
  AvatarAttach: ReturnType<typeof generated.AvatarAttach>
  SkyboxTime: ReturnType<typeof generated.SkyboxTime>
  PlayerIdentityData: ReturnType<typeof generated.PlayerIdentityData>
  AvatarBase: ReturnType<typeof generated.AvatarBase>
  AvatarEquippedData: ReturnType<typeof generated.AvatarEquippedData>
  AvatarEmoteCommand: ReturnType<typeof generated.AvatarEmoteCommand>
  Tween: ReturnType<typeof generated.Tween>
  TweenState: ReturnType<typeof generated.TweenState>
  TweenSequence: ReturnType<typeof generated.TweenSequence>
  PointerEvents: ReturnType<typeof generated.PointerEvents>
  PointerEventsResult: ReturnType<typeof generated.PointerEventsResult>
  TriggerArea: ReturnType<typeof generated.TriggerArea>
  TriggerAreaResult: ReturnType<typeof generated.TriggerAreaResult>
  Raycast: ReturnType<typeof generated.Raycast>
  RaycastResult: ReturnType<typeof generated.RaycastResult>
  PrimaryPointerInfo: ReturnType<typeof generated.PrimaryPointerInfo>
  VideoPlayer: ReturnType<typeof generated.VideoPlayer>
  VideoEvent: ReturnType<typeof generated.VideoEvent>
  AudioSource: ReturnType<typeof generated.AudioSource>
  AudioStream: ReturnType<typeof generated.AudioStream>
  AudioEvent: ReturnType<typeof generated.AudioEvent>
  ParticleSystem: ReturnType<typeof generated.ParticleSystem>
  UiTransform: ReturnType<typeof generated.UiTransform>
  UiText: ReturnType<typeof generated.UiText>
  UiBackground: ReturnType<typeof generated.UiBackground>
  UiInput: ReturnType<typeof generated.UiInput>
  UiInputResult: ReturnType<typeof generated.UiInputResult>
  UiDropdown: ReturnType<typeof generated.UiDropdown>
  UiDropdownResult: ReturnType<typeof generated.UiDropdownResult>
  UiCanvasInformation: ReturnType<typeof generated.UiCanvasInformation>
}

/** Register mirror ECS components so incoming scene CRDT can be applied. */
export function registerMirrorComponents(engine: IEngine): MirrorComponents {
  return {
    Transform: extended.Transform(engine),
    Tags: extended.Tags(engine),
    MeshRenderer: extended.MeshRenderer(engine),
    MeshCollider: extended.MeshCollider(engine),
    Material: extended.Material(engine),
    GltfContainer: generated.GltfContainer(engine),
    VisibilityComponent: generated.VisibilityComponent(engine),
    LightSource: generated.LightSource(engine),
    TextShape: generated.TextShape(engine),
    Billboard: generated.Billboard(engine),
    Animator: generated.Animator(engine),
    MainCamera: generated.MainCamera(engine),
    AvatarLocomotionSettings: generated.AvatarLocomotionSettings(engine),
    InputModifier: generated.InputModifier(engine),
    AvatarShape: generated.AvatarShape(engine),
    AvatarAttach: generated.AvatarAttach(engine),
    SkyboxTime: generated.SkyboxTime(engine),
    PlayerIdentityData: generated.PlayerIdentityData(engine),
    AvatarBase: generated.AvatarBase(engine),
    AvatarEquippedData: generated.AvatarEquippedData(engine),
    AvatarEmoteCommand: generated.AvatarEmoteCommand(engine),
    Tween: generated.Tween(engine),
    TweenState: generated.TweenState(engine),
    TweenSequence: generated.TweenSequence(engine),
    PointerEvents: generated.PointerEvents(engine),
    PointerEventsResult: generated.PointerEventsResult(engine),
    TriggerArea: generated.TriggerArea(engine),
    TriggerAreaResult: generated.TriggerAreaResult(engine),
    Raycast: generated.Raycast(engine),
    RaycastResult: generated.RaycastResult(engine),
    PrimaryPointerInfo: generated.PrimaryPointerInfo(engine),
    VideoPlayer: generated.VideoPlayer(engine),
    VideoEvent: generated.VideoEvent(engine),
    AudioSource: generated.AudioSource(engine),
    AudioStream: generated.AudioStream(engine),
    AudioEvent: generated.AudioEvent(engine),
    ParticleSystem: generated.ParticleSystem(engine),
    UiTransform: generated.UiTransform(engine),
    UiText: generated.UiText(engine),
    UiBackground: generated.UiBackground(engine),
    UiInput: generated.UiInput(engine),
    UiInputResult: generated.UiInputResult(engine),
    UiDropdown: generated.UiDropdown(engine),
    UiDropdownResult: generated.UiDropdownResult(engine),
    UiCanvasInformation: generated.UiCanvasInformation(engine)
  }
}
