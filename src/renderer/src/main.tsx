import { createRoot } from 'react-dom/client'
import { App } from './App'
import { CrashScreen } from './components/CrashScreen'
import './styles/tokens.css'
import './styles/app.css'
import './styles/editor.css'
import './styles/documents.css'

createRoot(document.getElementById('root')!).render(
  <CrashScreen>
    <App />
  </CrashScreen>
)
