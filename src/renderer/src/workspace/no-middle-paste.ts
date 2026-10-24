/**
 * В Linux отпускание средней кнопки вклеивает последнее выделение (PRIMARY) в то поле, над
 * которым мышь. На холсте средняя кнопка — панорама, и каждый сдвиг вида над терминалом
 * подмешивал выделенный когда-то текст в ввод агента. Вставку средней кнопкой выключаем во
 * всём окне; Ctrl+V и Ctrl+Shift+V работают как раньше.
 *
 * Ловим по pointer-, а не mouse-событиям: холст гасит pointerdown средней кнопки, и
 * mousedown после этого браузер не шлёт.
 */
export function disableMiddleClickPaste(target: Window = window): () => void {
  let middle = false
  const down = (e: PointerEvent): void => {
    if (e.button === 1) middle = true
  }
  const up = (e: PointerEvent): void => {
    // Вставка случается в том же таске сразу после отпускания — сбрасываем следующим.
    if (e.button === 1) setTimeout(() => (middle = false), 0)
  }
  const block = (e: Event): void => {
    if (!middle) return
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
