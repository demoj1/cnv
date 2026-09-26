import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { FILE_PROTOCOL } from '@shared/app'

const md = new MarkdownIt({ html: true, linkify: true, breaks: false })

const ALLOWED_URI_REGEXP = new RegExp(
  `^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|${FILE_PROTOCOL}):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))`,
  'i'
)

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i

/** Пути в канвасе — относительные от корня workspace, так же трактуем и ссылки в markdown. */
function toWorkspaceUrl(src: string): string {
  if (!src || src.startsWith('#') || src.startsWith('//') || EXTERNAL.test(src)) return src
  return window.api.files.url(src.replace(/^\.\//, ''))
}

export function renderMarkdown(source: string): string {
  const html = md.render(source)
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP,
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'script'],
    FORBID_ATTR: ['style']
  })

  const holder = document.createElement('div')
  holder.innerHTML = clean
  for (const img of holder.querySelectorAll('img')) {
    img.src = toWorkspaceUrl(img.getAttribute('src') ?? '')
    img.loading = 'lazy'
  }
  for (const a of holder.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? ''
    a.dataset.href = href
    if (!EXTERNAL.test(href) && !href.startsWith('#')) a.dataset.workspace = 'true'
  }
  return holder.innerHTML
}

/** Первая осмысленная строка — заголовок карточки при малом zoom (LOD, ТЗ 6.1). */
export function markdownSummary(source: string): string {
  for (const line of source.split('\n')) {
    const text = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+(\[.\]\s*)?/, '')
      .trim()
    if (text) return text.replace(/[*_`~]/g, '')
  }
  return ''
}
