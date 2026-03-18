import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import TandAApp from './TandA.tsx'

const path = window.location.pathname;

ReactDOM.createRoot(document.getElementById('root')!).render(
  path.startsWith('/tanda') ? <TandAApp /> : <App />
)
