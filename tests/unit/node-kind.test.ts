import { describe, expect, it } from 'vitest'
import { isHtmlFile, isImageFile, isMarkdownFile, isPdfFile } from '@core/node-kind'

describe('распознавание файлов по расширению', () => {
  it('картинки', () => {
    expect(isImageFile('a.png')).toBe(true)
    expect(isImageFile('A/B/pic.JPEG')).toBe(true)
    expect(isImageFile('doc.pdf')).toBe(false)
  })

  it('pdf и markdown', () => {
    expect(isPdfFile('report.PDF')).toBe(true)
    expect(isMarkdownFile('note.md')).toBe(true)
    expect(isMarkdownFile('note.markdown')).toBe(false)
  })

  it('html и htm — это веб-страница, а не файл', () => {
    expect(isHtmlFile('page.html')).toBe(true)
    expect(isHtmlFile('a/b/INDEX.HTM')).toBe(true)
    expect(isHtmlFile('note.md')).toBe(false)
    expect(isHtmlFile('pic.png')).toBe(false)
  })
})
