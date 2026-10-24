/**
 * В Linux отпускание средней кнопки вклеивает последнее выделение (PRIMARY) в то поле, над
 * которым мышь. На холсте средняя кнопка — панорама, и каждый сдвиг вида над терминалом
 * подмешивал выделенный когда-то текст в ввод агента. Вставку средней кнопкой выключаем во
 * всём окне; Ctrl+V и Ctrl+Shift+V работают как раньше.
 *
 * Ловим по pointer-, а не mouse-событиям: холст гасит pointerdown средней кнопки, и
 * mousedown после этого браузер не шлёт.
 */
const RELEASE_WINDOW_MS = 400

export function disableMiddleClickPaste(target: Window = window): () => void {
  let held = false
  let releasedAt = -Infinity
  const down = (e: PointerEvent): void => {
    if (e.button === 1) held = true
  }
  const up = (e: PointerEvent): void => {
    if (e.button !== 1) return
    held = false
    releasedAt = performance.now()
  }
  // Вставка приходит сразу за отпусканием, но под нагрузкой — не в том же таске: держим
  // окно. Ctrl+V за доли секунды после средней кнопки руками не нажать.
  const fromMiddle = (): boolean => held || performance.now() - releasedAt < RELEASE_WINDOW_MS
  const block = (e: Event): void => {
    if (!fromMiddle()) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  const beforeInput = (e: InputEvent): void => {
    if (e.inputType === 'insertFromPaste') block(e)
  }
  target.addEventListener('pointerdown', down, true)
  target.addEventListener('pointerup', up, true)
  target.addEventListener('paste', block, true)
  target.addEventListener('beforeinput', beforeInput, true)
  return () => {
    target.removeEventListener('pointerdown', down, true)
    target.removeEventListener('pointerup', up, true)
    target.removeEventListener('paste', block, true)
    target.removeEventListener('beforeinput', beforeInput, true)
  }
}
