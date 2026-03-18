import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import TandAApp from './TandA.tsx'

// Route based on URL path — each app opens independently
// Design Calendar: https://design-calendar-app.vercel.app/
// T&A Calendar:    https://design-calendar-app.vercel.app/tanda
const path = window.location.pathname;

ReactDOM.createRoot(document.getElementById('root')!).render(
  path.startsWith('/tanda') ? <TandAApp /> : <App />
)
