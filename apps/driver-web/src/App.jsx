import { Navigate, useLocation, useNavigate } from 'react-router';
import { AppShell, SessionPanel } from '@leroutier/ui';
import { useSession } from '@leroutier/config/client';
import { RouteScreen, Profile } from './screens.jsx';
import { Route, UserRound } from 'lucide-react';
const nav=[{id:'route',label:'Feuille de route',icon:Route},{id:'profile',label:'Profil & bord',icon:UserRound}];
export default function App() {
  const { online } = useSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const page = pathname.replace(/\/$/, '').slice(1) || 'route';
  if (page !== 'route' && page !== 'profile') return <Navigate to="/" replace />;
  return <AppShell online={online} role="Chauffeur" title={page === 'route' ? 'Feuille de route & embarquement' : 'Profil & documents de bord'} subtitle="Console conducteur" nav={nav} active={page} onNavigate={id => navigate('/' + id)}><SessionPanel />{page === 'route' ? <RouteScreen /> : <Profile />}</AppShell>;
}
