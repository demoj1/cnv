import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { cameraToTransform } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import { useCameraInteractions } from './useCameraInteractions'
import { GridLayer } from './GridLayer'

interface Props {
  camera: CameraController
  showGrid: boolean
  gridSize: number
  wheelZooms: boolean
  zoomSpeed: number
  children?: ReactNode
  overlay?: ReactNode
}

export function CanvasView({
  camera,
  showGrid,
  gridSize,
  wheelZooms,
  zoomSpeed,
  children,
  overlay
}: Props): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)

  useCameraInteractions(viewportRef, camera, { wheelZooms, zoomSpeed })

  useLayoutEffect(() => {
    const world = worldRef.current
    if (!world) return
    world.style.transform = cameraToTransform(camera.value)
    return camera.subscribeRaw((cam) => {
      world.style.transform = cameraToTransform(cam)
    })
  }, [camera])

  useEffect(() => {
    const world = worldRef.current
    if (!world) return
    return camera.subscribeInteraction((active) => {
      world.style.willChange = active ? 'transform' : 'auto'
    })
  }, [camera])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const apply = (): void => {
      const rect = el.getBoundingClientRect()
      camera.setViewport({ width: rect.width, height: rect.height })
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => observer.disconnect()
  }, [camera])

  return (
    <div className="viewport" ref={viewportRef} data-testid="viewport">
      {showGrid && <GridLayer camera={camera} size={gridSize} />}
      <div className="world" ref={worldRef} data-testid="world">
        {children}
      </div>
      <div className="overlay">{overlay}</div>
    </div>
  )
}
