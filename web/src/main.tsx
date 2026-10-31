// In this order: the editor reads the API the moment it loads.
import './installApi'
import '../../src/renderer/src/main'
import './web.css'

document.documentElement.dataset.platform = 'web'
