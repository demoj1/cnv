export type Listener<T> = (value: T) => void
export type Unsubscribe = () => void

export interface Store<T> {
  get(): T
  set(next: T): void
  update(fn: (prev: T) => T): void
  subscribe(listener: Listener<T>): Unsubscribe
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<Listener<T>>()
  const set = (next: T): void => {
    if (Object.is(next, value)) return
    value = next
    for (const l of [...listeners]) l(value)
  }
  return {
    get: () => value,
    set,
    update: (fn) => set(fn(value)),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
