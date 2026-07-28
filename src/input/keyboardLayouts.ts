/**
 * Visual keyboard layouts for the keybinds editor.
 *
 * Bindings always use KeyboardEvent.code (physical key position — layout-independent).
 * Labels change per layout so AZERTY/QWERTZ users see the glyphs they know on each key.
 *
 * @see https://www.w3.org/TR/uievents-code/ — codes are fixed US-QWERTY positions.
 */

export type KeyboardLayoutId = 'qwerty-us' | 'qwerty-uk' | 'azerty-fr' | 'qwertz-de' | 'dvorak-us'

export type KeyboardLayoutDef = {
  id: KeyboardLayoutId
  /** Short select option */
  label: string
  /** Longer description */
  description: string
}

export const KEYBOARD_LAYOUTS: readonly KeyboardLayoutDef[] = [
  { id: 'qwerty-us', label: 'QWERTY (US)', description: 'US English' },
  { id: 'qwerty-uk', label: 'QWERTY (UK)', description: 'UK English' },
  { id: 'azerty-fr', label: 'AZERTY (FR)', description: 'French' },
  { id: 'qwertz-de', label: 'QWERTZ (DE)', description: 'German' },
  { id: 'dvorak-us', label: 'Dvorak (US)', description: 'US Dvorak' }
]

export type KeyWide = 'wide' | 'wider' | 'space' | 'enter' | 'shift'

/** One physical key on the board (always a KeyboardEvent.code). */
export type KeyboardKeySpec = {
  code: string
  wide?: KeyWide
  /** Never assignable (Esc cancel only, etc.) */
  locked?: boolean
}

/**
 * Full main-block + arrows + numpad physical positions.
 * Glyphs come from layout maps — not hard-coded here.
 */
export const KEYBOARD_BOARD: readonly (readonly KeyboardKeySpec[])[] = [
  // Number row
  [
    { code: 'Escape', locked: true },
    { code: 'Backquote' },
    { code: 'Digit1' },
    { code: 'Digit2' },
    { code: 'Digit3' },
    { code: 'Digit4' },
    { code: 'Digit5' },
    { code: 'Digit6' },
    { code: 'Digit7' },
    { code: 'Digit8' },
    { code: 'Digit9' },
    { code: 'Digit0' },
    { code: 'Minus' },
    { code: 'Equal' },
    { code: 'Backspace', wide: 'wide' }
  ],
  // Q row
  [
    { code: 'Tab', wide: 'wide' },
    { code: 'KeyQ' },
    { code: 'KeyW' },
    { code: 'KeyE' },
    { code: 'KeyR' },
    { code: 'KeyT' },
    { code: 'KeyY' },
    { code: 'KeyU' },
    { code: 'KeyI' },
    { code: 'KeyO' },
    { code: 'KeyP' },
    { code: 'BracketLeft' },
    { code: 'BracketRight' },
    { code: 'Backslash', wide: 'wide' }
  ],
  // A row
  [
    { code: 'CapsLock', wide: 'wider' },
    { code: 'KeyA' },
    { code: 'KeyS' },
    { code: 'KeyD' },
    { code: 'KeyF' },
    { code: 'KeyG' },
    { code: 'KeyH' },
    { code: 'KeyJ' },
    { code: 'KeyK' },
    { code: 'KeyL' },
    { code: 'Semicolon' },
    { code: 'Quote' },
    { code: 'Enter', wide: 'enter' }
  ],
  // Z row
  [
    { code: 'ShiftLeft', wide: 'shift' },
    { code: 'KeyZ' },
    { code: 'KeyX' },
    { code: 'KeyC' },
    { code: 'KeyV' },
    { code: 'KeyB' },
    { code: 'KeyN' },
    { code: 'KeyM' },
    { code: 'Comma' },
    { code: 'Period' },
    { code: 'Slash' },
    { code: 'ShiftRight', wide: 'shift' }
  ],
  // Bottom modifiers
  [
    { code: 'ControlLeft', wide: 'wide' },
    { code: 'MetaLeft', wide: 'wide' },
    { code: 'AltLeft', wide: 'wide' },
    { code: 'Space', wide: 'space' },
    { code: 'AltRight', wide: 'wide' },
    { code: 'MetaRight', wide: 'wide' },
    { code: 'ControlRight', wide: 'wide' }
  ]
]

export const KEYBOARD_ARROWS: readonly KeyboardKeySpec[] = [
  { code: 'ArrowUp' },
  { code: 'ArrowLeft' },
  { code: 'ArrowDown' },
  { code: 'ArrowRight' }
]

export const KEYBOARD_NUMPAD: readonly (readonly KeyboardKeySpec[])[] = [
  [
    { code: 'NumLock' },
    { code: 'NumpadDivide' },
    { code: 'NumpadMultiply' },
    { code: 'NumpadSubtract' }
  ],
  [
    { code: 'Numpad7' },
    { code: 'Numpad8' },
    { code: 'Numpad9' },
    { code: 'NumpadAdd' }
  ],
  [
    { code: 'Numpad4' },
    { code: 'Numpad5' },
    { code: 'Numpad6' }
  ],
  [
    { code: 'Numpad1' },
    { code: 'Numpad2' },
    { code: 'Numpad3' },
    { code: 'NumpadEnter' }
  ],
  [
    { code: 'Numpad0', wide: 'wide' },
    { code: 'NumpadDecimal' }
  ]
]

/** Shared non-letter labels (same on most layouts). */
const SHARED: Record<string, string> = {
  Escape: 'Esc',
  Backspace: '⌫',
  Tab: 'Tab',
  CapsLock: 'Caps',
  Enter: '↵',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  MetaLeft: '⌘',
  MetaRight: '⌘',
  Space: 'Space',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  NumLock: 'Num',
  NumpadDivide: '/',
  NumpadMultiply: '*',
  NumpadSubtract: '−',
  NumpadAdd: '+',
  NumpadEnter: '↵',
  NumpadDecimal: '.',
  Numpad0: '0',
  Numpad1: '1',
  Numpad2: '2',
  Numpad3: '3',
  Numpad4: '4',
  Numpad5: '5',
  Numpad6: '6',
  Numpad7: '7',
  Numpad8: '8',
  Numpad9: '9',
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  Digit4: '4',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
  Digit8: '8',
  Digit9: '9',
  Digit0: '0'
}

/** code → glyph for letter/symbol keys that differ by layout. */
type LabelMap = Partial<Record<string, string>>

const QWERTY_US: LabelMap = {
  Backquote: '`',
  Minus: '−',
  Equal: '=',
  KeyQ: 'Q',
  KeyW: 'W',
  KeyE: 'E',
  KeyR: 'R',
  KeyT: 'T',
  KeyY: 'Y',
  KeyU: 'U',
  KeyI: 'I',
  KeyO: 'O',
  KeyP: 'P',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  KeyA: 'A',
  KeyS: 'S',
  KeyD: 'D',
  KeyF: 'F',
  KeyG: 'G',
  KeyH: 'H',
  KeyJ: 'J',
  KeyK: 'K',
  KeyL: 'L',
  Semicolon: ';',
  Quote: "'",
  KeyZ: 'Z',
  KeyX: 'X',
  KeyC: 'C',
  KeyV: 'V',
  KeyB: 'B',
  KeyN: 'N',
  KeyM: 'M',
  Comma: ',',
  Period: '.',
  Slash: '/'
}

const QWERTY_UK: LabelMap = {
  ...QWERTY_US,
  Backquote: '`',
  // UK often shows #/~ near Enter; physical Backslash still used.
  Backslash: '#'
}

/** French AZERTY labels on US physical codes. */
const AZERTY_FR: LabelMap = {
  Backquote: '²',
  Digit1: '&',
  Digit2: 'é',
  Digit3: '"',
  Digit4: "'",
  Digit5: '(',
  Digit6: '-',
  Digit7: 'è',
  Digit8: '_',
  Digit9: 'ç',
  Digit0: 'à',
  Minus: ')',
  Equal: '=',
  KeyQ: 'A',
  KeyW: 'Z',
  KeyE: 'E',
  KeyR: 'R',
  KeyT: 'T',
  KeyY: 'Y',
  KeyU: 'U',
  KeyI: 'I',
  KeyO: 'O',
  KeyP: 'P',
  BracketLeft: '^',
  BracketRight: '$',
  Backslash: '*',
  KeyA: 'Q',
  KeyS: 'S',
  KeyD: 'D',
  KeyF: 'F',
  KeyG: 'G',
  KeyH: 'H',
  KeyJ: 'J',
  KeyK: 'K',
  KeyL: 'L',
  Semicolon: 'M',
  Quote: 'ù',
  KeyZ: 'W',
  KeyX: 'X',
  KeyC: 'C',
  KeyV: 'V',
  KeyB: 'B',
  KeyN: 'N',
  KeyM: ',',
  Comma: ';',
  Period: ':',
  Slash: '!'
}

/** German QWERTZ. */
const QWERTZ_DE: LabelMap = {
  Backquote: '^',
  Minus: 'ß',
  Equal: '´',
  KeyQ: 'Q',
  KeyW: 'W',
  KeyE: 'E',
  KeyR: 'R',
  KeyT: 'T',
  KeyY: 'Z',
  KeyU: 'U',
  KeyI: 'I',
  KeyO: 'O',
  KeyP: 'P',
  BracketLeft: 'Ü',
  BracketRight: '+',
  Backslash: '#',
  KeyA: 'A',
  KeyS: 'S',
  KeyD: 'D',
  KeyF: 'F',
  KeyG: 'G',
  KeyH: 'H',
  KeyJ: 'J',
  KeyK: 'K',
  KeyL: 'L',
  Semicolon: 'Ö',
  Quote: 'Ä',
  KeyZ: 'Y',
  KeyX: 'X',
  KeyC: 'C',
  KeyV: 'V',
  KeyB: 'B',
  KeyN: 'N',
  KeyM: 'M',
  Comma: ',',
  Period: '.',
  Slash: '-'
}

/** US Dvorak — labels on physical US key positions. */
const DVORAK_US: LabelMap = {
  Backquote: '`',
  Minus: '[',
  Equal: ']',
  KeyQ: "'",
  KeyW: ',',
  KeyE: '.',
  KeyR: 'P',
  KeyT: 'Y',
  KeyY: 'F',
  KeyU: 'G',
  KeyI: 'C',
  KeyO: 'R',
  KeyP: 'L',
  BracketLeft: '/',
  BracketRight: '=',
  Backslash: '\\',
  KeyA: 'A',
  KeyS: 'O',
  KeyD: 'E',
  KeyF: 'U',
  KeyG: 'I',
  KeyH: 'D',
  KeyJ: 'H',
  KeyK: 'T',
  KeyL: 'N',
  Semicolon: 'S',
  Quote: '-',
  KeyZ: ';',
  KeyX: 'Q',
  KeyC: 'J',
  KeyV: 'K',
  KeyB: 'X',
  KeyN: 'B',
  KeyM: 'M',
  Comma: 'W',
  Period: 'V',
  Slash: 'Z'
}

const LAYOUT_MAPS: Record<KeyboardLayoutId, LabelMap> = {
  'qwerty-us': QWERTY_US,
  'qwerty-uk': QWERTY_UK,
  'azerty-fr': AZERTY_FR,
  'qwertz-de': QWERTZ_DE,
  'dvorak-us': DVORAK_US
}

const LAYOUT_STORAGE_KEY = 'dcl-client-keyboard-layout-v1'

export function isKeyboardLayoutId(v: unknown): v is KeyboardLayoutId {
  return typeof v === 'string' && KEYBOARD_LAYOUTS.some((l) => l.id === v)
}

export function loadKeyboardLayoutId(): KeyboardLayoutId {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (isKeyboardLayoutId(raw)) return raw
  } catch {
    /* private mode */
  }
  // Prefer browser language hint
  const lang = (navigator.language || '').toLowerCase()
  if (lang.startsWith('fr')) return 'azerty-fr'
  if (lang.startsWith('de') || lang.startsWith('de-ch')) return 'qwertz-de'
  if (lang === 'en-gb') return 'qwerty-uk'
  return 'qwerty-us'
}

export function saveKeyboardLayoutId(id: KeyboardLayoutId): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}

/** Glyph shown on the board for a physical code under the active layout. */
export function layoutKeyLabel(layout: KeyboardLayoutId, code: string): string {
  const shared = SHARED[code]
  if (shared && !LAYOUT_MAPS[layout][code]) return shared
  const fromLayout = LAYOUT_MAPS[layout][code]
  if (fromLayout) return fromLayout
  if (shared) return shared
  // Fallback: KeyQ → Q
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  return code
}
