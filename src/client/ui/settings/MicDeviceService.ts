export type MicDeviceOption = {
  deviceId: string
  label: string
}

type Listener = (devices: MicDeviceOption[]) => void

const DEFAULT_OPTION: MicDeviceOption = { deviceId: '', label: 'Default microphone' }

/** Enumerates audio input devices for the preferences mic picker. */
export class MicDeviceService {
  private devices: MicDeviceOption[] = [DEFAULT_OPTION]
  private readonly listeners = new Set<Listener>()
  private mediaDevicesListener: (() => void) | null = null

  getDevices(): MicDeviceOption[] {
    return [...this.devices]
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getDevices())
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Request mic permission so browsers expose human-readable device labels. */
  async ensurePermission(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) return
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      /* user denied or no hardware */
    } finally {
      for (const track of stream?.getTracks() ?? []) track.stop()
    }
  }

  async refresh(): Promise<MicDeviceOption[]> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      this.devices = [DEFAULT_OPTION]
      this.notify()
      return this.getDevices()
    }

    const raw = await navigator.mediaDevices.enumerateDevices()
    const inputs = raw.filter((d) => d.kind === 'audioinput')
    if (inputs.length === 0) {
      this.devices = [{ deviceId: '', label: 'No microphone found' }]
      this.notify()
      return this.getDevices()
    }

    this.devices = inputs.map((d, index) => ({
      deviceId: d.deviceId,
      label: d.label?.trim() || `Microphone ${index + 1}`
    }))
    this.notify()
    return this.getDevices()
  }

  bindDeviceChange(): void {
    if (this.mediaDevicesListener || !navigator.mediaDevices?.addEventListener) return
    this.mediaDevicesListener = () => {
      void this.refresh()
    }
    navigator.mediaDevices.addEventListener('devicechange', this.mediaDevicesListener)
  }

  unbindDeviceChange(): void {
    if (!this.mediaDevicesListener || !navigator.mediaDevices?.removeEventListener) return
    navigator.mediaDevices.removeEventListener('devicechange', this.mediaDevicesListener)
    this.mediaDevicesListener = null
  }

  private notify(): void {
    const snapshot = this.getDevices()
    for (const listener of this.listeners) listener(snapshot)
  }
}

export const micDeviceService = new MicDeviceService()