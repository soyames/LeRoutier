import { ApiProvider } from '@leroutier/config/client';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import '@leroutier/ui/styles.css';
import App from './App.jsx';

// One identity for every workspace: the provider accepts all roles and the app
// decides which workspaces the authenticated identity may open. Deep links
// carry an optional id segment so a refresh lands on the same content.
createRoot(document.getElementById('root')).render(
  <React.StrictMode><BrowserRouter>
    <ApiProvider baseUrl={import.meta.env.VITE_API_URL} role={['passenger', 'driver', 'convoyeur', 'ops']}>
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
