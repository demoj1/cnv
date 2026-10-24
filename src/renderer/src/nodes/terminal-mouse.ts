/**
 * Терминал живёт внутри масштабированного холста (CSS transform), а xterm переводит мышь в
 * клетки как (clientX − левый край экрана) / ширина клетки — ширина клетки у него без
 * масштаба. При zoom ≠ 1 выделение и клики уезжают тем дальше, чем дальше от левого
 * верхнего угла. Чиним до xterm: в его мышиных событиях подменяем clientX/clientY так,
 * чтобы смещение от экрана терминала было уже без масштаба.
 *
 * wheel не трогаем — по нему холст зумит к курсору, и координаты ему нужны настоящие;
 * pointer-события — отдельные объекты, их холст видит как есть.
 */

const EVENTS = ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'] as const

/** Пометка «уже пересчитано»: терминалов много, и каждый слушает окно. */
const UNSCALED = Symbol('cnv-unscaled')

export function unscaleTerminalMouse(host: HTMLElement): () => void {
  // Выделение тянется и за пределы терминала — xterm слушает тогда документ, и эти события
  // тоже его: пересчитываем, пока кнопка, нажатая в терминале, не отпущена.
  let dragging = false

  const fix = (e: MouseEvent): void => {
    const inside = e.target instanceof Node && host.contains(e.target)
    if (e.type === 'mousedown' && inside) dragging = true
    const ours = inside || dragging
    if (e.type === 'mouseup' && dragging) setTimeout(() => (dragging = false), 0)
    if (!ours || (e as MouseEvent & { [UNSCALED]?: true })[UNSCALED]) return

    const screen = host.querySelector<HTMLElement>('.xterm-screen')
    if (!screen || screen.offsetWidth === 0 || screen.offsetHeight === 0) return
    const rect = screen.getBoundingClientRect()
    const sx = rect.width / screen.offsetWidth
    const sy = rect.height / screen.offsetHeight
    if (Math.abs(sx - 1) < 1e-3 && Math.abs(sy - 1) < 1e-3) return

    const x = rect.left + (e.clientX - rect.left) / sx
    const y = rect.top + (e.clientY - rect.top) / sy
    Object.defineProperties(e, {
      clientX: { value: x },
      clientY: { value: y },
      [UNSCALED]: { value: true }
    })
  }

  for (const type of EVENTS) window.addEventListener(type, fix, true)
  return () => {
    for (const type of EVENTS) window.removeEventListener(type, fix, true)
  }
}
