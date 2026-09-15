import { Navigate, useLocation, useNavigate } from 'react-router';
import { AppShell, SessionPanel } from '@leroutier/ui';
import { useSession } from '@leroutier/config/client';
import { Trips, Tickets, Stations, Tracking, Account, Parcels, OnboardingPage } from './screens.jsx';
import { Search, Ticket, Navigation, UserRound, Package, Store } from 'lucide-react';
const nav=[{id:'trips',label:'Trajets',icon:Search},{id:'tickets',label:'Billets',icon:Ticket},{id:'parcels',label:'Colis',icon:Package},{id:'tracking',label:'Suivi',icon:Navigation},{id:'account',label:'Compte',icon:UserRound}];
export default function App() {
  const { online } = useSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const page = pathname.replace(/\/$/, '').slice(1) || 'trips';
  if (page === 'onboarding') {
    return <AppShell online={online} role="Devenir opérateur" title="Rejoindre LeRoutier" subtitle="Compagnie ou chauffeur indépendant" nav={[{id:'trips',label:'Retour aux trajets',icon:Search}]} active="" onNavigate={()=>navigate('/trips')}><OnboardingPage/></AppShell>;
  }
  const screens = { trips: <Trips />, tickets: <Tickets />, stations: <Stations />, parcels: <Parcels />, tracking: <Tracking />, account: <Account /> };
  const titles = { trips: 'Recherche de trajets', tickets: 'Mes billets', stations: 'Gares & arrêts', parcels: 'Colis & fret', tracking: 'Suivi du voyage', account: 'Mon compte' };
  if (!Object.hasOwn(screens, page)) return <Navigate to="/" replace />;
  const navWithOnboarding = [...nav];
  if (page !== 'account') navWithOnboarding.push({ id: 'onboarding', label: 'Devenir opérateur', icon: Store });
  return <AppShell online={online} role="Voyageur" title={titles[page]} subtitle="LeRoutier Bénin" nav={navWithOnboarding} active={page} onNavigate={id => navigate('/' + id)}><SessionPanel />{screens[page]}</AppShell>;
}
