import { EMPTY_DOC, type CanvasDoc, type DocNode } from './document'
import { applyTransaction, diffDocs, type Transaction } from './history'
import type { Unsubscribe } from './observable'

export type SelectionMode = 'replace' | 'add' | 'toggle'

export interface DocState {
  doc: CanvasDoc
  selection: ReadonlySet<string>
  edgeSelection: ReadonlySet<string>
  activeNodeId: string | null
  canUndo: boolean
  canRedo: boolean
  dirty: boolean
}

const EMPTY_SET: ReadonlySet<string> = new Set()
const HISTORY_LIMIT = 200

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

export class DocStore {
  private state: DocState = {
    doc: EMPTY_DOC,
    selection: EMPTY_SET,
    edgeSelection: EMPTY_SET,
    activeNodeId: null,
    canUndo: false,
    canRedo: false,
    dirty: false
  }
  private past: Transaction[] = []
  private future: Transaction[] = []
  private txBase: CanvasDoc | null = null
  private txLabel = ''
  private listeners = new Set<(state: DocState) => void>()

  get snapshot(): DocState {
    return this.state
  }

  get doc(): CanvasDoc {
    return this.state.doc
  }

  subscribe(listener: (state: DocState) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(next: Partial<DocState>): void {
    this.state = { ...this.state, ...next }
    for (const l of [...this.listeners]) l(this.state)
  }

  /** Загрузка документа с диска: история и признак несохранённости сбрасываются. */
  load(doc: CanvasDoc): void {
    this.past = []
    this.future = []
    this.txBase = null
    this.emit({
      doc,
      selection: EMPTY_SET,
      edgeSelection: EMPTY_SET,
      activeNodeId: null,
      canUndo: false,
      canRedo: false,
      dirty: false
    })
  }

  markSaved(): void {
    if (this.state.dirty) this.emit({ dirty: false })
  }

  /** Начало транзакции: всё, что произойдёт до `commit`, попадёт в историю одной записью. */
  begin(label: string): void {
    if (this.txBase) throw new Error(`транзакция «${this.txLabel}» не закрыта`)
    this.txBase = this.state.doc
    this.txLabel = label
  }

  commit(): void {
    const base = this.txBase
    if (!base) throw new Error('commit без begin')
    this.txBase = null
    this.pushHistory(base, this.state.doc, this.txLabel)
  }

  abort(): void {
    const base = this.txBase
    if (!base) throw new Error('abort без begin')
    this.txBase = null
    if (base !== this.state.doc) this.emit({ doc: base })
  }

  get inTransaction(): boolean {
    return this.txBase !== null
  }

  /** Правка документа. Вне транзакции — сама себе транзакция. */
  mutate(label: string, fn: (doc: CanvasDoc) => CanvasDoc): void {
    const before = this.state.doc
    const after = fn(before)
    if (after === before) return
    this.emit({ doc: after, dirty: true })
    if (!this.txBase) this.pushHistory(before, after, label)
  }

  /** Правка мимо истории: навигация внутри веб-ноды, служебные поля (ТЗ 7.6). */
  mutateSilent(fn: (doc: CanvasDoc) => CanvasDoc): void {
    const after = fn(this.state.doc)
    if (after === this.state.doc) return
    this.emit({ doc: after, dirty: true })
  }

  /**
   * Записать в историю правку, которую уже применили мимо неё. Нужно для CodeMirror:
   * у него своя история, а на холст сессия редактирования попадает одной записью (ТЗ 7.6).
   */
  recordNodePatch(label: string, id: string, before: Partial<DocNode>): void {
    const current = this.state.doc.nodes.find((n) => n.id === id)
    if (!current) throw new Error(`нет ноды ${id}`)
    const after: Partial<DocNode> = {}
    let changed = false
    for (const key of Object.keys(before) as (keyof DocNode)[]) {
      const value = current[key]
      if (value === before[key]) continue
      Object.assign(after, { [key]: value })
      changed = true
    }
    if (!changed) return
    this.past.push({
      label,
      nodes: new Map([[id, { kind: 'update', before, after }]]),
      edges: new Map(),
      nodeOrder: null,
      edgeOrder: null,
      rootExtra: null
    })
    if (this.past.length > HISTORY_LIMIT) this.past.shift()
    this.future = []
    this.emit({ canUndo: true, canRedo: false })
  }

  private pushHistory(before: CanvasDoc, after: CanvasDoc, label: string): void {
    const tx = diffDocs(before, after, label)
    if (!tx) return
    this.past.push(tx)
    if (this.past.length > HISTORY_LIMIT) this.past.shift()
    this.future = []
    this.emit({ canUndo: true, canRedo: false })
  }

  undo(): void {
    const tx = this.past.pop()
    if (!tx) return
    this.future.push(tx)
    this.applyAndSync(applyTransaction(this.state.doc, tx, true))
  }

  redo(): void {
    const tx = this.future.pop()
    if (!tx) return
    this.past.push(tx)
    this.applyAndSync(applyTransaction(this.state.doc, tx, false))
  }

  private applyAndSync(doc: CanvasDoc): void {
    const alive = new Set(doc.nodes.map((n) => n.id))
    const selection = new Set([...this.state.selection].filter((id) => alive.has(id)))
    const aliveEdges = new Set(doc.edges.map((e) => e.id))
    const edgeSelection = new Set([...this.state.edgeSelection].filter((id) => aliveEdges.has(id)))
    const activeNodeId =
      this.state.activeNodeId && alive.has(this.state.activeNodeId) ? this.state.activeNodeId : null
    this.emit({
      doc,
      dirty: true,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      selection: sameSet(selection, this.state.selection) ? this.state.selection : selection,
      edgeSelection: sameSet(edgeSelection, this.state.edgeSelection)
        ? this.state.edgeSelection
        : edgeSelection,
      activeNodeId
    })
  }

  selectNodes(ids: readonly string[], mode: SelectionMode = 'replace'): void {
    const next = new Set(mode === 'replace' ? [] : this.state.selection)
    for (const id of ids) {
      if (mode === 'toggle' && next.has(id)) next.delete(id)
      else next.add(id)
    }
    if (sameSet(next, this.state.selection)) return
    this.emit({ selection: next, edgeSelection: mode === 'replace' ? EMPTY_SET : this.state.edgeSelection })
  }

  selectEdges(ids: readonly string[], mode: SelectionMode = 'replace'): void {
    const next = new Set(mode === 'replace' ? [] : this.state.edgeSelection)
    for (const id of ids) {
      if (mode === 'toggle' && next.has(id)) next.delete(id)
      else next.add(id)
    }
    if (sameSet(next, this.state.edgeSelection)) return
    this.emit({ edgeSelection: next, selection: mode === 'replace' ? EMPTY_SET : this.state.selection })
  }

  clearSelection(): void {
    if (this.state.selection.size === 0 && this.state.edgeSelection.size === 0) return
    this.emit({ selection: EMPTY_SET, edgeSelection: EMPTY_SET })
  }

  selectAll(): void {
    this.selectNodes(
      this.state.doc.nodes.map((n) => n.id),
      'replace'
    )
  }

  setActiveNode(id: string | null): void {
    if (this.state.activeNodeId === id) return
    this.emit({ activeNodeId: id })
  }
}
