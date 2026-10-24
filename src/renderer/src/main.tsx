import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { SnapshotApp } from './snapshot/SnapshotApp'
import { disableMiddleClickPaste } from './workspace/no-middle-paste'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

disableMiddleClickPaste()

const container = document.getElementById('root')
if (!container) throw new Error('#root не найден')

// Скрытое окно снимка нод — тот же холст, но только для кадра (см. main/snapshot.ts).
const snapshot = location.hash === '#snapshot'

createRoot(container).render(<StrictMode>{snapshot ? <SnapshotApp /> : <App />}</StrictMode>)
