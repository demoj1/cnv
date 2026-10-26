const NAMED: Record<string, string> = {
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  hellip: '…',
  rarr: '→',
  larr: '←',
  times: '×',
  copy: '©',
  euro: '€'
}

/** HTML → читаемый текст для агента: без скриптов, стилей и тегов, с переносами на блоках. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|ul|ol)>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(
      /&(mdash|ndash|laquo|raquo|hellip|rarr|larr|times|copy|euro);/g,
      (_, name: string) => NAMED[name] ?? ''
    )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\f\v]+/g, (m) => (m.includes('\t') ? '\t' : ' '))
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
