import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { disableMiddleClickPaste } from './workspace/no-middle-paste'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

disableMiddleClickPaste()

const container = document.getElementById('root')
if (!container) throw new Error('#root не найден')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
