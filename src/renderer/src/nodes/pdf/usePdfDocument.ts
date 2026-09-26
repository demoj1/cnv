import { useEffect, useState } from 'react'
import { loadPdf, type PdfDocument } from './pdfjs'

export interface PdfDocumentState {
  doc: PdfDocument | null
  pages: number
  error: string | null
}

const LOADING: PdfDocumentState = { doc: null, pages: 0, error: null }

export function usePdfDocument(url: string, reloadToken: number): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>(LOADING)

  useEffect(() => {
    let cancelled = false
    // Документ закрывается через loading task: у PDFDocumentProxy своего destroy нет.
    const task = loadPdf(url)
    task.promise.then(
      (doc) => {
        if (!cancelled) setState({ doc, pages: doc.numPages, error: null })
      },
      (e: unknown) => {
        if (!cancelled) setState({ doc: null, pages: 0, error: e instanceof Error ? e.message : String(e) })
      }
    )
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [url, reloadToken])

  return state
}
