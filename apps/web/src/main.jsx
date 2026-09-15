import { ApiProvider } from '@leroutier/config/client';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import '@leroutier/ui/styles.css';
import App from './App.jsx';

// VITE_API_URL may be an absolute API origin, or the literal "same-origin" to
// call /api/v1 on whatever domain serves the app. Same-origin goes through the
// rewrite in vercel.json, so attaching a custom domain later needs no rebuild
// and no CORS entry. An unset value stays empty and the client fails closed.
const apiUrl = import.meta.env.VITE_API_URL === 'same-origin'
  ? window.location.origin
  : import.meta.env.VITE_API_URL;

// One identity for every workspace: the provider accepts all roles and the app
// decides which workspaces the authenticated identity may open. Deep links
// carry an optional id segment so a refresh lands on the same content.
createRoot(document.getElementById('root')).render(
  <React.StrictMode><BrowserRouter>
    <ApiProvider baseUrl={apiUrl} role={['passenger', 'driver', 'convoyeur', 'ops']}>
      <Routes>
        <Route path="/:section/:id" element={<App/>}/>
        <Route path="/:section" element={<App/>}/>
        <Route path="/work/:section/:id" element={<App/>}/>
        <Route path="/work/:section" element={<App/>}/>
        <Route path="/ops/:section/:id" element={<App/>}/>
        <Route path="/ops/:section" element={<App/>}/>
        <Route path="*" element={<App/>}/>
      </Routes>
    </ApiProvider>
  </BrowserRouter></React.StrictMode>,
);
