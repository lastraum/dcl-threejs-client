declare module 'qrcode' {
  const QRCode: {
    toDataURL(
      text: string,
      opts?: {
        width?: number
        margin?: number
        errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
        color?: { dark?: string; light?: string }
      }
    ): Promise<string>
  }
  export default QRCode
}
