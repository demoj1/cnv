export type CanvasColorPreset = '1' | '2' | '3' | '4' | '5' | '6'
export type CanvasColor = CanvasColorPreset | string

export type NodeSide = 'top' | 'right' | 'bottom' | 'left'
export type EdgeEnd = 'none' | 'arrow'
export type BackgroundStyle = 'cover' | 'ratio' | 'repeat'

export type UnknownFields = Record<string, unknown>

interface NodeBase {
  id: string
  x: number
  y: number
  width: number
  height: number
  color?: CanvasColor
}

export interface TextNode extends NodeBase {
  type: 'text'
  text: string
}

export interface FileNode extends NodeBase {
  type: 'file'
  file: string
  subpath?: string
}

export interface LinkNode extends NodeBase {
  type: 'link'
  url: string
}

export interface GroupNode extends NodeBase {
  type: 'group'
  label?: string
  background?: string
  backgroundStyle?: BackgroundStyle
}

export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode
export type CanvasNodeType = CanvasNode['type']

export interface CanvasEdge {
  id: string
  fromNode: string
  fromSide?: NodeSide
  fromEnd?: EdgeEnd
  toNode: string
  toSide?: NodeSide
  toEnd?: EdgeEnd
  color?: CanvasColor
  label?: string
}

export interface CanvasDocument {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export const NODE_KNOWN_KEYS: Readonly<Record<CanvasNodeType, readonly string[]>> = {
  text: ['id', 'type', 'x', 'y', 'width', 'height', 'color', 'text'],
  file: ['id', 'type', 'x', 'y', 'width', 'height', 'color', 'file', 'subpath'],
  link: ['id', 'type', 'x', 'y', 'width', 'height', 'color', 'url'],
  group: ['id', 'type', 'x', 'y', 'width', 'height', 'color', 'label', 'background', 'backgroundStyle']
}

export const EDGE_KNOWN_KEYS: readonly string[] = [
  'id',
  'fromNode',
  'fromSide',
  'fromEnd',
  'toNode',
  'toSide',
  'toEnd',
  'color',
  'label'
]

export const ROOT_KNOWN_KEYS: readonly string[] = ['nodes', 'edges']

export const NODE_SIDES: readonly NodeSide[] = ['top', 'right', 'bottom', 'left']
