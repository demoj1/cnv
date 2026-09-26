import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjs }
export type PdfDocument = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>
export type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>

export function loadPdf(url: string): ReturnType<typeof pdfjs.getDocument> {
  return pdfjs.getDocument({ url })
}
