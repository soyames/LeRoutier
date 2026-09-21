import { ApiProvider } from '@leroutier/config/client';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import '@leroutier/ui/styles.css';
import './stitch-polish.css';
import App from './App.jsx';
import {PwaUpdate} from './pwa-update.jsx';
import {Assistant} from './assistant.jsx';
import { About } from './about.jsx';
import { LegalNotice, PrivacyPolicy, TermsOfUse, CancellationPolicy, CookiePolicy } from './legal.jsx';
import { Seo } from './seo.jsx';
import { BusBeninPage, RoutePage, ColisBeninPage, StationsBeninPage, TransporteursBeninPage } from './seo-pages.jsx';

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
      <PwaUpdate/>
      <Seo/>
      <Routes>
        <Route path="/about" element={<About/>}/>
        <Route path="/bus-benin" element={<BusBeninPage/>}/>
        <Route path="/cotonou-parakou" element={<RoutePage slug="cotonou-parakou"/>}/>
        <Route path="/cotonou-porto-novo" element={<RoutePage slug="cotonou-porto-novo"/>}/>
        <Route path="/cotonou-bohicon" element={<RoutePage slug="cotonou-bohicon"/>}/>
        <Route path="/cotonou-natitingou" element={<RoutePage slug="cotonou-natitingou"/>}/>
        <Route path="/colis-benin" element={<ColisBeninPage/>}/>
        <Route path="/gares-routieres-benin" element={<StationsBeninPage/>}/>
        <Route path="/transporteurs-benin" element={<TransporteursBeninPage/>}/>
        <Route path="/legal" element={<LegalNotice/>}/>
        <Route path="/privacy" element={<PrivacyPolicy/>}/>
        <Route path="/terms" element={<TermsOfUse/>}/>
        <Route path="/cancellations" element={<CancellationPolicy/>}/>
        <Route path="/cookies" element={<CookiePolicy/>}/>
        <Route path="/:section/:id" element={<App/>}/>
        <Route path="/:section" element={<App/>}/>
        <Route path="/work/:section/:id" element={<App/>}/>
        <Route path="/work/:section" element={<App/>}/>
        <Route path="/ops/:section/:id" element={<App/>}/>
        <Route path="/ops/:section" element={<App/>}/>
        <Route path="*" element={<App/>}/>
      </Routes>
      {/* After the shell in DOM order, so the app's skip link stays the first
          tabbable element and the launcher never steals the keyboard start. */}
      <Assistant/>
    </ApiProvider>
  </BrowserRouter></React.StrictMode>,
);
