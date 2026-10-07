import { ApiProvider } from '@leroutier/config/client';
import { BrandLoader } from '@leroutier/ui';
import React, { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
// One stylesheet, one set of tokens. There used to be a second layer here
// ("stitch-polish") that overrode the first with `!important`; the two files
// kept fighting over the same properties, and the layer that always won was
// the one nobody thought to look in. It is merged into @leroutier/ui now.
import '@leroutier/ui/styles.css';
import App from './App.jsx';
import {PwaUpdate} from './pwa-update.jsx';
import {Assistant} from './assistant.jsx';
import { About } from './about.jsx';
import { LegalNotice, PrivacyPolicy, TermsOfUse, CancellationPolicy, CookiePolicy } from './legal.jsx';
import { Seo } from './seo.jsx';
import { VerifyEmail } from './verify-email.jsx';
import { BusBeninPage, RoutePage, ColisBeninPage, StationsBeninPage, TransporteursBeninPage } from './seo-pages.jsx';
import { PageChrome } from './page-chrome.jsx';
import { CORRIDORS } from './corridors.js';
// Imported for its side effect and imported EARLY: it listens for
// `beforeinstallprompt`, which Chromium fires once, soon after load. Miss it
// and the assistant can only describe the install instead of opening it.
import './pwa-install.js';

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
      {/* The first paint, before any screen exists. The application bundle is
          small and this is over almost immediately, which is exactly why it is
          the brand mark rather than a screenful of placeholder: it reserves its
          own box, shows nothing at all for the first fraction of a second, and
          hands over to the real shell without the page moving. */}
      <Suspense fallback={<BrandLoader label="Chargement de LeRoutier…"/>}>
      <Routes>
        {/* Routed above <App>, so they carry their own instance of the public
            shell. They used to carry no header at all: a visitor arriving from
            a search engine had one link in the footer as the only way back. */}
        <Route path="/about" element={<PageChrome><About/></PageChrome>}/>
        <Route path="/bus-benin" element={<PageChrome><BusBeninPage/></PageChrome>}/>
        {CORRIDORS.map(corridor =>
          <Route key={corridor.slug} path={`/${corridor.slug}`} element={<PageChrome><RoutePage slug={corridor.slug}/></PageChrome>}/>)}
        <Route path="/colis-benin" element={<PageChrome><ColisBeninPage/></PageChrome>}/>
        <Route path="/gares-routieres-benin" element={<PageChrome><StationsBeninPage/></PageChrome>}/>
        <Route path="/transporteurs-benin" element={<PageChrome><TransporteursBeninPage/></PageChrome>}/>
        <Route path="/legal" element={<PageChrome><LegalNotice/></PageChrome>}/>
        <Route path="/privacy" element={<PageChrome><PrivacyPolicy/></PageChrome>}/>
        <Route path="/terms" element={<PageChrome><TermsOfUse/></PageChrome>}/>
        <Route path="/cancellations" element={<PageChrome><CancellationPolicy/></PageChrome>}/>
        <Route path="/cookies" element={<PageChrome><CookiePolicy/></PageChrome>}/>
        {/* The destination of the account-verification email. A fixed route, so
            it can never be shadowed by the workspace sections below. */}
        <Route path="/verify-email" element={<PageChrome><VerifyEmail/></PageChrome>}/>
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
      </Suspense>
    </ApiProvider>
  </BrowserRouter></React.StrictMode>,
);
