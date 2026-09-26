import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CameraController } from '@core/camera-controller'
import type { DocStore } from '@core/doc-store'
import { parseCanvas, serializeCanvas } from '@core/serialization'
import {
  EMPTY_VIEW_STATE,
  nodeViewState,
  parseViewState,
  sidecarPath,
  withNodeViewState,
  type CanvasViewState,
  type NodeViewState
} from '@core/sidecar'
import type { ExternalChange } from '@shared/api'

const AUTOSAVE_MS = 1000
/** Страховочное сохранение: даже если debounce всё время сбрасывается правками. */
const PERIODIC_SAVE_MS = 30_000

export type ConflictChoice = 'reload' | 'keep' | 'save-copy'

export interface NodeViewStateApi {
  get(nodeId: string): NodeViewState
  patch(nodeId: string, patch: NodeViewState): void
}

export interface CanvasFileState {
  relPath: string | null
  conflict: ExternalChange | null
  error: string | null
  viewState: NodeViewStateApi
  open(relPath: string): Promise<void>
  close(): void
  save(): Promise<void>
  resolveConflict(choice: ConflictChoice): Promise<void>
}

export function useCanvasFile(store: DocStore, camera: CameraController): CanvasFileState {
  const [relPath, setRelPath] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ExternalChange | null>(null)
  const [error, setError] = useState<string | null>(null)

  const relPathRef = useRef<string | null>(null)
  const viewStateRef = useRef<CanvasViewState>(EMPTY_VIEW_STATE)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sidecarTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingViewState = useRef(false)

  const writeSidecar = useCallback(async () => {
    const path = relPathRef.current
    if (!path || savingViewState.current) return
    savingViewState.current = true
    try {
      const next: CanvasViewState = { ...viewStateRef.current, camera: camera.value }
      viewStateRef.current = next
      await window.api.canvas.write(sidecarPath(path), JSON.stringify(next))
    } finally {
      savingViewState.current = false
    }
  }, [camera])

  const save = useCallback(async () => {
    const path = relPathRef.current
    if (!path) return
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    try {
      await window.api.canvas.write(path, serializeCanvas(store.doc))
      store.markSaved()
      await writeSidecar()
      setError(null)
    } catch (e) {
      setError(`не сохранилось: ${String(e)}`)
    }
  }, [store, writeSidecar])

  const open = useCallback(
    async (path: string) => {
      try {
        const file = await window.api.canvas.read(path)
        const doc = parseCanvas(file.text)
        relPathRef.current = path
        setRelPath(path)
        setConflict(null)
        setError(null)
        store.load(doc)
        const sidecar = parseViewState(await window.api.files.readText(sidecarPath(path)))
        viewStateRef.current = sidecar
        if (sidecar.camera) camera.set(sidecar.camera)
        else camera.set({ x: 0, y: 0, zoom: 1 })
      } catch (e) {
        setError(`не открылось: ${String(e)}`)
      }
    },
    [store, camera]
  )

  const scheduleSidecar = useCallback(() => {
    if (sidecarTimer.current) clearTimeout(sidecarTimer.current)
    sidecarTimer.current = setTimeout(() => void writeSidecar(), AUTOSAVE_MS)
  }, [writeSidecar])

  const viewState = useMemo<NodeViewStateApi>(
    () => ({
      get: (nodeId) => nodeViewState(viewStateRef.current, nodeId),
      patch: (nodeId, patch) => {
        viewStateRef.current = withNodeViewState(viewStateRef.current, nodeId, patch)
        scheduleSidecar()
      }
    }),
    [scheduleSidecar]
  )

  const close = useCallback(() => {
    relPathRef.current = null
    setRelPath(null)
    setConflict(null)
  }, [])

  useEffect(() => {
    const unsubscribe = store.subscribe((state) => {
      if (!state.dirty || !relPathRef.current) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void save(), AUTOSAVE_MS)
    })
    return () => {
      unsubscribe()
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [store, save])

  useEffect(
    () =>
      camera.subscribeFrame(() => {
        if (relPathRef.current) scheduleSidecar()
      }),
    [camera, scheduleSidecar]
  )

  useEffect(() => {
    const timer = setInterval(() => {
      if (store.snapshot.dirty) void save()
    }, PERIODIC_SAVE_MS)
    return () => clearInterval(timer)
  }, [store, save])

  // main дожидается этого промиса перед закрытием окна — иначе теряется последняя правка.
  useEffect(() => {
    const flush = async (): Promise<void> => {
      if (store.snapshot.dirty) await save()
      await writeSidecar()
    }
    Object.assign(window, { __cnvFlush: flush })
    return () => {
      Reflect.deleteProperty(window, '__cnvFlush')
    }
  }, [store, save, writeSidecar])

  useEffect(
    () =>
      window.api.canvas.onExternalChange((change) => {
        if (change.relPath !== relPathRef.current) return
        if (change.kind === 'unlink') {
          setConflict(change)
          return
        }
        if (store.snapshot.dirty) setConflict(change)
        else void open(change.relPath)
      }),
    [store, open]
  )

  const resolveConflict = useCallback(
    async (choice: ConflictChoice) => {
      const change = conflict
      if (!change) return
      setConflict(null)
      if (choice === 'reload') {
        await open(change.relPath)
        return
      }
      if (choice === 'keep') {
        await save()
        return
      }
      const copy = change.relPath.replace(
        /\.canvas$/,
        ` (копия ${new Date().toISOString().slice(0, 19)}).canvas`
      )
      await window.api.canvas.write(copy, serializeCanvas(store.doc))
      await open(change.relPath)
    },
    [conflict, open, save, store]
  )

  return { relPath, conflict, error, viewState, open, close, save, resolveConflict }
}
