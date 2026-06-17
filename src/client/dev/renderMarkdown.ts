/** Minimal markdown → HTML for dev panel (headings, lists, tables, code, links). */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderInlineMarkdown(text: string): string {
  let out = escapeHtml(text)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  return out
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith('|') && line.trim().endsWith('|')
}

function isTableSep(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim())
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim())
}

export function renderMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const parts: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    if (line.startsWith('```')) {
      const fence = line.trim()
      const lang = fence.slice(3).trim()
      i++
      const codeLines: string[] = []
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ''
      parts.push(`<pre><code${cls}>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = parseTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(parseTableRow(lines[i]))
        i++
      }
      let table = '<table><thead><tr>'
      for (const cell of header) table += `<th>${renderInlineMarkdown(cell)}</th>`
      table += '</tr></thead><tbody>'
      for (const row of rows) {
        table += '<tr>'
        for (const cell of row) table += `<td>${renderInlineMarkdown(cell)}</td>`
        table += '</tr>'
      }
      table += '</tbody></table>'
      parts.push(table)
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      parts.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`)
      i++
      continue
    }

    if (line.trim() === '---') {
      parts.push('<hr />')
      i++
      continue
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, '').replace(/\s+$/, ''))
        i++
      }
      const paras = quote.map((q) => `<p>${renderInlineMarkdown(q)}</p>`).join('')
      parts.push(`<blockquote>${paras}</blockquote>`)
      continue
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''))
        i++
      }
      parts.push('<ul>')
      for (const item of items) parts.push(`<li>${renderInlineMarkdown(item)}</li>`)
      parts.push('</ul>')
      continue
    }

    const para: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*]\s|```|>\s?|\|)/.test(lines[i])) {
      para.push(lines[i])
      i++
    }
    parts.push(`<p>${renderInlineMarkdown(para.join(' '))}</p>`)
  }

  return parts.join('\n')
}