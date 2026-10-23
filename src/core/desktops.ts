import { findNode, nodeRect, type CanvasDoc, type DocNode } from './document'
import { clamp, type Point, type Rect } from './geometry'
import { patchNodes } from './ops'

/**
 * Рабочие столы — не отдельные файлы, а далеко разнесённые участки одного холста:
 * стол N начинается в x = (N−1)·SPAN. Так терминалы и агенты других столов продолжают
 * жить (их ноды в том же документе), MCP видит все столы разом, а все жесты, привязки и
 * поиск попаданий работают без фильтров — соседний стол просто очень далеко. Obsidian
 * покажет столы отдельными кластерами.
 */

export const DESKTOP_COUNT = 10
/**
 * Расстояние между столами. Больше — надёжнее разделение, но крупнее сдвиг камеры, а
 * композитор считает трансформы во float32: на 10-м столе при zoom 4 это ~3.6 млн px и
 * точность ~0.25 px — ещё не видно.
 */
export const DESKTOP_SPAN = 100_000

export const desktopOrigin = (desktop: number): Point => ({ x: (desktop - 1) * DESKTOP_SPAN, y: 0 })

/** Стол, на который приходится мировая абсцисса. Всё левее первого — первый, правее последнего — последний. */
export function desktopAtX(x: number): number {
  return clamp(Math.floor((x + DESKTOP_SPAN / 2) / DESKTOP_SPAN) + 1, 1, DESKTOP_COUNT)
}

export const desktopOfRect = (r: Rect): number => desktopAtX(r.x + r.width / 2)
export const desktopOfNode = (n: DocNode): number => desktopOfRect(nodeRect(n))

/** Подпись стола: так, как его зовут хоткеи — Alt+1 … Alt+9, Alt+0 для десятого. */
export const desktopKey = (desktop: number): string => String(desktop % 10)

export const isDesktop = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= DESKTOP_COUNT

export function nodesOnDesktop(doc: CanvasDoc, desktop: number): DocNode[] {
  return doc.nodes.filter((n) => desktopOfNode(n) === desktop)
}

/** Перенести ноды на другой стол, сохранив их положение относительно начала стола. */
export function moveToDesktop(doc: CanvasDoc, ids: Iterable<string>, desktop: number): CanvasDoc {
  const patches = new Map<string, Partial<DocNode>>()
  for (const id of ids) {
    const node = findNode(doc, id)
    if (!node) continue
    const from = desktopOfNode(node)
    if (from === desktop) continue
    patches.set(id, { x: node.x + (desktop - from) * DESKTOP_SPAN })
  }
  return patchNodes(doc, patches)
}

export interface DesktopSummary {
  desktop: number
  nodes: number
}

/** Сколько нод на каждом столе — для индикатора и для агентов. */
export function desktopSummary(doc: CanvasDoc): DesktopSummary[] {
  const counts = new Array<number>(DESKTOP_COUNT).fill(0)
  for (const n of doc.nodes) counts[desktopOfNode(n) - 1]! += 1
  return counts.map((nodes, i) => ({ desktop: i + 1, nodes }))
}
