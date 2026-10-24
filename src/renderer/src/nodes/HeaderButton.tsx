import { useEffect, useRef } from 'react'

/**
 * Кнопка в шапке ноды — имя или роль: клик открывает диалог правки. Нажатие не должно
 * доходить до холста, иначе он начнёт тащить ноду; холст слушает нативный pointerdown,
 * поэтому React-овский stopPropagation опоздал бы.
 */
export function HeaderButton({
  className,
  testId,
  title,
  onClick,
  children
}: {
  className: string
  testId: string
  title: string
  onClick(): void
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: Event): void => e.stopPropagation()
    el.addEventListener('pointerdown', stop)
    return () => el.removeEventListener('pointerdown', stop)
  }, [])
  return (
    <button
      ref={ref}
      type="button"
      className={className}
      data-testid={testId}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
