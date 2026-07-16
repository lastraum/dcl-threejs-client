/**
 * Parse the latest `### What's new` block from docs/PROGRESS.md.
 * Convention: each shipped milestone has that heading + short `-` bullets.
 */

export type WhatsNewBlock = {
  /** Milestone H2 title (without leading emoji/date noise trimmed lightly). */
  milestoneTitle: string
  bullets: string[]
}

/** First milestone's What's new bullets (newest is top of PROGRESS.md). */
export function parseLatestWhatsNew(markdown: string): WhatsNewBlock | null {
  const text = markdown.replace(/\r\n/g, '\n')
  // First H2 milestone heading
  const h2 = text.match(/^##\s+(.+)$/m)
  if (!h2 || h2.index === undefined) return null
  const afterH2 = text.slice(h2.index + h2[0].length)
  const nextH2 = afterH2.search(/\n##\s+/)
  const section = nextH2 >= 0 ? afterH2.slice(0, nextH2) : afterH2

  const whatsIdx = section.search(/^###\s+What's new\s*$/im)
  if (whatsIdx < 0) return null
  const afterWhats = section.slice(whatsIdx).replace(/^###\s+What's new\s*\n?/i, '')
  const end = afterWhats.search(/\n###\s+|\n##\s+|\n\*\*[A-Z]|\n\| /)
  const bulletBlock = (end >= 0 ? afterWhats.slice(0, end) : afterWhats).trim()

  const bullets: string[] = []
  for (const line of bulletBlock.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(.+)$/)
    if (!m) {
      if (bullets.length && line.trim() === '') break
      continue
    }
    const item = m[1]!.replace(/\*\*/g, '').trim()
    if (item) bullets.push(item)
  }
  if (!bullets.length) return null

  let milestoneTitle = h2[1]!.trim()
  milestoneTitle = milestoneTitle
    .replace(/^🎉\s*Milestone\s*—\s*/i, '')
    .replace(/\s*→\s*`?dev-latest`?.*$/i, '')
    .replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/i, '')
    .trim()

  return { milestoneTitle, bullets }
}
