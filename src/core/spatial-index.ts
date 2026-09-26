import RBush from 'rbush'
import { rectRight, rectBottom, type Rect } from './geometry'

interface Entry {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: string
}

const toEntry = (id: string, rect: Rect): Entry => ({
  minX: rect.x,
  minY: rect.y,
  maxX: rectRight(rect),
  maxY: rectBottom(rect),
  id
})

/** Пространственный индекс нод: кандидаты для culling и для привязки при перетаскивании. */
export class SpatialIndex {
  private tree = new RBush<Entry>()
  private rects = new Map<string, Rect>()

  get size(): number {
    return this.rects.size
  }

  rebuild(items: readonly { id: string; rect: Rect }[]): void {
    this.rects = new Map(items.map((i) => [i.id, i.rect]))
    this.tree = new RBush<Entry>()
    this.tree.load(items.map((i) => toEntry(i.id, i.rect)))
  }

  /** Перестраивает индекс, только если набор прямоугольников действительно изменился. */
  sync(items: readonly { id: string; rect: Rect }[]): boolean {
    if (items.length === this.rects.size) {
      let same = true
      for (const i of items) {
        const known = this.rects.get(i.id)
        if (
          !known ||
          known.x !== i.rect.x ||
          known.y !== i.rect.y ||
          known.width !== i.rect.width ||
          known.height !== i.rect.height
        ) {
          same = false
          break
        }
      }
      if (same) return false
    }
    this.rebuild(items)
    return true
  }

  search(area: Rect): string[] {
    return this.tree
      .search({ minX: area.x, minY: area.y, maxX: rectRight(area), maxY: rectBottom(area) })
      .map((e) => e.id)
  }

  rectOf(id: string): Rect | undefined {
    return this.rects.get(id)
  }
}
