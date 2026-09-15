import { Navigate, useLocation, useNavigate } from 'react-router';
import { AppShell, SessionPanel } from '@leroutier/ui';
import { useSession } from '@leroutier/config/client';
import { Trips, Tickets, Stations, Tracking, Account, Parcels } from './screens.jsx';
import { Search, Ticket, Navigation, UserRound, Package } from 'lucide-react';
const nav=[{id:'trips',label:'Trajets',icon:Search},{id:'tickets',label:'Billets',icon:Ticket},{id:'parcels',label:'Colis',icon:Package},{id:'tracking',label:'Suivi',icon:Navigation},{id:'account',label:'Compte',icon:UserRound}];
export default function App() {
  const { online } = useSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const page = pathname.replace(/\/$/, '').slice(1) || 'trips';
  const screens = { trips: <Trips />, tickets: <Tickets />, stations: <Stations />, parcels: <Parcels />, tracking: <Tracking />, account: <Account /> };
  const titles = { trips: 'Recherche de trajets', tickets: 'Mes billets', stations: 'Gares & arrêts', parcels: 'Colis & fret', tracking: 'Suivi du voyage', account: 'Mon compte' };
  if (!Object.hasOwn(screens, page)) return <Navigate to="/" replace />;
  return <AppShell online={online} role="Voyageur" title={titles[page]} subtitle="LeRoutier Bénin" nav={nav} active={page} onNavigate={id => navigate('/' + id)}><SessionPanel />{screens[page]}</AppShell>;
}
