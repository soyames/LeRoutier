import { ApiProvider } from '@leroutier/config/client';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import '@leroutier/ui/styles.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode><BrowserRouter><ApiProvider baseUrl={import.meta.env.VITE_API_URL} role="passenger"><App /></ApiProvider></BrowserRouter></React.StrictMode>,
);
