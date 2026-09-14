import { ApiProvider } from '@leroutier/config/client';
import React from'react';import{createRoot}from'react-dom/client';import'@leroutier/ui/styles.css';import App from'./App.jsx';createRoot(document.getElementById('root')).render(<React.StrictMode><ApiProvider baseUrl={import.meta.env.VITE_API_URL} role="ops"><App /></ApiProvider></React.StrictMode>);
