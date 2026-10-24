/** Снимок нод без сдвига камеры человеку: что рисует скрытое окно. */
export interface SnapshotRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SnapshotPayload {
  /** Ноды и связи документа как есть (DocNode / DocEdge). */
  nodes: unknown[]
  edges: unknown[]
  /** Что снимать — в мировых координатах. */
  rect: SnapshotRect
  /** Текст экранов терминалов: живой xterm есть только в окне холста. */
  terminals: Record<string, string>
  /** Кадры веб-страниц (data:image/png): живой браузер — тоже только там. */
  web: Record<string, string>
}
