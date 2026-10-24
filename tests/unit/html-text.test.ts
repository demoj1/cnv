import { describe, expect, it } from 'vitest'
import { htmlToText } from '../../src/main/mcp/html-text'

describe('HTML в текст', () => {
  it('без скриптов и стилей, с переносами на блоках и сущностями', () => {
    const html = `<html><head><style>p{color:red}</style><script>alert(1)</script></head>
      <body><h1>Телефоны</h1><p>Pixel&nbsp;9 &mdash; <b>59&#160;990 ₽</b></p><ul><li>раз</li><li>два</li></ul></body></html>`
    expect(htmlToText(html)).toBe('Телефоны\nPixel 9 — 59 990 ₽\nраз\nдва')
  })

  it('таблица — ячейки через табуляцию', () => {
    expect(htmlToText('<table><tr><td>a</td><td>b</td></tr></table>')).toBe('a\tb')
  })
})
