import { InputAction, type InputActionValue } from './pointerConstants'

/**
 * Local keyboard remapping for DCL client actions.
 *
 * Explorer defaults (WASD / arrows / Space / Shift / Ctrl / E F / 1–4) are the
 * baseline. Users can rebind so browser shortcuts (e.g. Ctrl+W close tab) no
 * longer collide with walk+forward.
 */

const STORAGE_KEY = 'dcl-client-keybinds-v1'

/** Logical bind slots shown in Controls settings. */
export type KeybindId =
  | 'forward'
  | 'backward'
  | 'left'
  | 'right'
  | 'jump'
  | 'walk'
  | 'modifier'
  | 'primary'
  | 'secondary'
  | 'action3'
  | 'action4'
  | 'action5'
  | 'action6'

export type KeybindsMap = Record<KeybindId, string[]>

export type KeybindMeta = {
  id: KeybindId
  /** Short UI label */
  label: string
  /** Longer description for the list */
  description: string
  /** DCL InputAction this slot drives */
  action: InputActionValue
  /** Category for grouping in settings */
  group: 'movement' | 'actions'
}

/** Explorer-parity defaults. Multiple codes = alternate physical keys. */
export const DEFAULT_KEYBINDS: KeybindsMap = {
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  walk: ['ControlLeft', 'ControlRight'],
  modifier: ['ShiftLeft', 'ShiftRight'],
  primary: ['KeyE'],
  secondary: ['KeyF'],
  action3: ['Digit1', 'Numpad1'],
  action4: ['Digit2', 'Numpad2'],
  action5: ['Digit3', 'Numpad3'],
  action6: ['Digit4', 'Numpad4']
}

export const KEYBIND_META: readonly KeybindMeta[] = [
  {
    id: 'forward',
    label: 'Forward',
    description: 'Move / fly forward (IA_FORWARD)',
    action: InputAction.IA_FORWARD,
    group: 'movement'
  },
  {
    id: 'backward',
    label: 'Backward',
    description: 'Move / fly backward (IA_BACKWARD)',
    action: InputAction.IA_BACKWARD,
    group: 'movement'
  },
  {
    id: 'left',
    label: 'Left',
    description: 'Strafe left (IA_LEFT)',
    action: InputAction.IA_LEFT,
    group: 'movement'
  },
  {
    id: 'right',
    label: 'Right',
    description: 'Strafe right (IA_RIGHT)',
    action: InputAction.IA_RIGHT,
    group: 'movement'
  },
  {
    id: 'jump',
    label: 'Jump',
    description: 'Jump (IA_JUMP)',
    action: InputAction.IA_JUMP,
    group: 'movement'
  },
  {
    id: 'walk',
    label: 'Walk',
    description: 'Walk / slow (IA_WALK) — default Ctrl conflicts with browser Ctrl+W',
    action: InputAction.IA_WALK,
    group: 'movement'
  },
  {
    id: 'modifier',
    label: 'Modifier',
    description: 'Shift modifier (IA_MODIFIER)',
    action: InputAction.IA_MODIFIER,
    group: 'movement'
  },
  {
    id: 'primary',
    label: 'Primary',
    description: 'Primary interact E (IA_PRIMARY)',
    action: InputAction.IA_PRIMARY,
    group: 'actions'
  },
  {
    id: 'secondary',
    label: 'Secondary',
    description: 'Secondary interact F (IA_SECONDARY)',
    action: InputAction.IA_SECONDARY,
    group: 'actions'
  },
  {
    id: 'action3',
    label: 'Action 3',
    description: 'Hotkey 1 (IA_ACTION_3)',
    action: InputAction.IA_ACTION_3,
    group: 'actions'
  },
  {
    id: 'action4',
    label: 'Action 4',
    description: 'Hotkey 2 (IA_ACTION_4)',
    action: InputAction.IA_ACTION_4,
    group: 'actions'
  },
  {
    id: 'action5',
    label: 'Action 5',
    description: 'Hotkey 3 (IA_ACTION_5)',
    action: InputAction.IA_ACTION_5,
    group: 'actions'
  },
  {
    id: 'action6',
    label: 'Action 6',
    description: 'Hotkey 4 (IA_ACTION_6)',
    action: InputAction.IA_ACTION_6,
    group: 'actions'
  }
]

const META_BY_ID = new Map(KEYBIND_META.map((m) => [m.id, m]))

type Listener = (map: KeybindsMap) => void

function cloneMap(map: KeybindsMap): KeybindsMap {
  const out = {} as KeybindsMap
  for (const id of Object.keys(DEFAULT_KEYBINDS) as KeybindId[]) {
    out[id] = [...(map[id] ?? DEFAULT_KEYBINDS[id])]
  }
  return out
}

function sanitizeCodes(codes: unknown): string[] | null {
  if (!Array.isArray(codes)) return null
  const out: string[] = []
  for (const c of codes) {
    if (typeof c !== 'string' || !c.trim()) continue
    if (!out.includes(c)) out.push(c)
  }
  return out.length ? out : null
}

/** Human-readable key label for UI badges. */
export function formatKeyCodeLabel(code: string): string {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  if (code.startsWith('Numpad') && code.length === 7) return `N${code.slice(6)}`
  switch (code) {
    case 'Space':
      return 'Space'
    case 'ControlLeft':
      return 'L-Ctrl'
    case 'ControlRight':
      return 'R-Ctrl'
    case 'ShiftLeft':
      return 'L-Shift'
    case 'ShiftRight':
      return 'R-Shift'
    case 'AltLeft':
      return 'L-Alt'
    case 'AltRight':
      return 'R-Alt'
    case 'MetaLeft':
      return 'L-Cmd'
    case 'MetaRight':
      return 'R-Cmd'
    case 'ArrowUp':
      return '↑'
    case 'ArrowDown':
      return '↓'
    case 'ArrowLeft':
      return '←'
    case 'ArrowRight':
      return '→'
    case 'CapsLock':
      return 'Caps'
    case 'Tab':
      return 'Tab'
    case 'Escape':
      return 'Esc'
    case 'Enter':
      return 'Enter'
    case 'Backspace':
      return 'Bksp'
    default:
      return code.replace(/([a-z])([A-Z])/g, '$1 $2')
  }
}

/** Join multiple codes for a badge (e.g. "W / ↑"). */
export function formatKeybindCodes(codes: readonly string[]): string {
  if (!codes.length) return '—'
  return codes.map(formatKeyCodeLabel).join(' / ')
}

/**
 * Expand a user-picked physical key into the stored code list.
 * Left/Right modifiers pair so either side works (Explorer parity).
 */
export function expandBoundCode(code: string): string[] {
  switch (code) {
    case 'ControlLeft':
    case 'ControlRight':
      return ['ControlLeft', 'ControlRight']
    case 'ShiftLeft':
    case 'ShiftRight':
      return ['ShiftLeft', 'ShiftRight']
    case 'AltLeft':
    case 'AltRight':
      return ['AltLeft', 'AltRight']
    case 'MetaLeft':
    case 'MetaRight':
      return ['MetaLeft', 'MetaRight']
    case 'Digit1':
    case 'Numpad1':
      return ['Digit1', 'Numpad1']
    case 'Digit2':
    case 'Numpad2':
      return ['Digit2', 'Numpad2']
    case 'Digit3':
    case 'Numpad3':
      return ['Digit3', 'Numpad3']
    case 'Digit4':
    case 'Numpad4':
      return ['Digit4', 'Numpad4']
    default:
      return [code]
  }
}

/** Codes that should not be bound (escape cancel, browser-only). */
export function isForbiddenBindCode(code: string): boolean {
  return (
    code === 'Escape' ||
    code === 'F5' ||
    code === 'F11' ||
    code === 'F12' ||
    code.startsWith('F') && /^F\d+$/.test(code)
  )
}

class KeybindsStore {
  private map: KeybindsMap
  private readonly listeners = new Set<Listener>()
  /** code → InputAction values (rebuilt on every change). */
  private codeToActions = new Map<string, InputActionValue[]>()
  /** code → KeybindId (first match wins for PlayerInput move slots). */
  private codeToBindId = new Map<string, KeybindId>()

  constructor() {
    this.map = cloneMap(DEFAULT_KEYBINDS)
    this.load()
    this.rebuildIndex()
  }

  get(): KeybindsMap {
    return cloneMap(this.map)
  }

  getCodes(id: KeybindId): readonly string[] {
    return this.map[id] ?? DEFAULT_KEYBINDS[id]
  }

  /** Actions triggered by this KeyboardEvent.code. */
  actionsForCode(code: string): readonly InputActionValue[] {
    return this.codeToActions.get(code) ?? []
  }

  bindIdForCode(code: string): KeybindId | undefined {
    return this.codeToBindId.get(code)
  }

  isCodeBound(code: string): boolean {
    return this.codeToBindId.has(code)
  }

  /** Primary display codes for keyboard highlight (first code per slot). */
  primaryCodeByBindId(): Map<KeybindId, string> {
    const out = new Map<KeybindId, string>()
    for (const id of Object.keys(this.map) as KeybindId[]) {
      const codes = this.map[id]
      if (codes[0]) out.set(id, codes[0])
    }
    return out
  }

  setBind(id: KeybindId, codes: string[]): void {
    const clean = sanitizeCodes(codes)
    if (!clean) return
    // Clear these codes from other slots (exclusive bind). Empty other slots stay
    // empty so defaults don't steal the key back — user rebinds the free action.
    const next = cloneMap(this.map)
    for (const other of Object.keys(next) as KeybindId[]) {
      if (other === id) continue
      next[other] = next[other].filter((c) => !clean.includes(c))
    }
    next[id] = clean
    this.map = next
    this.rebuildIndex()
    this.persist()
    this.notify()
  }

  /**
   * Bind from a single physical key (or keyboard-UI click).
   * Left/Right modifiers still pair so either side works; every other code is exact
   * (Tab, CapsLock, KeyQ, …) so non-Explorer keys can drive any InputAction.
   */
  setBindFromCode(id: KeybindId, code: string): boolean {
    if (isForbiddenBindCode(code)) return false
    this.setBind(id, expandBoundCode(code))
    return true
  }

  resetDefaults(): void {
    this.map = cloneMap(DEFAULT_KEYBINDS)
    this.rebuildIndex()
    this.persist()
    this.notify()
  }

  isDefault(): boolean {
    for (const id of Object.keys(DEFAULT_KEYBINDS) as KeybindId[]) {
      const a = this.map[id]
      const b = DEFAULT_KEYBINDS[id]
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    }
    return true
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  meta(id: KeybindId): KeybindMeta | undefined {
    return META_BY_ID.get(id)
  }

  private rebuildIndex(): void {
    this.codeToActions.clear()
    this.codeToBindId.clear()
    for (const meta of KEYBIND_META) {
      const codes = this.map[meta.id] ?? DEFAULT_KEYBINDS[meta.id]
      for (const code of codes) {
        const list = this.codeToActions.get(code) ?? []
        if (!list.includes(meta.action)) list.push(meta.action)
        this.codeToActions.set(code, list)
        if (!this.codeToBindId.has(code)) this.codeToBindId.set(code, meta.id)
      }
    }
  }

  private notify(): void {
    const snap = this.get()
    for (const l of this.listeners) l(snap)
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.map))
    } catch {
      /* private mode */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<Record<KeybindId, unknown>>
      const next = cloneMap(DEFAULT_KEYBINDS)
      for (const id of Object.keys(DEFAULT_KEYBINDS) as KeybindId[]) {
        const clean = sanitizeCodes(parsed[id])
        if (clean) next[id] = clean
      }
      this.map = next
    } catch {
      /* corrupt */
    }
  }
}

export const keybinds = new KeybindsStore()
