import { Navigate, useLocation, useNavigate } from 'react-router';
import { AppShell, SessionPanel } from '@leroutier/ui';
import { useSession } from '@leroutier/config/client';
import { RouteScreen, Profile, Earnings } from './screens.jsx';
import { Route, UserRound, Wallet } from 'lucide-react';
const nav=[{id:'route',label:'Feuille de route',icon:Route},{id:'earnings',label:'Gains',icon:Wallet},{id:'profile',label:'Profil & bord',icon:UserRound}];
export default function App() {
  const { online } = useSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const page = pathname.replace(/\/$/, '').slice(1) || 'route';
  if (page !== 'route' && page !== 'profile' && page !== 'earnings') return <Navigate to="/" replace />;
  const titles={route:'Feuille de route & embarquement',earnings:'Gains & versements',profile:'Profil & documents de bord'};
  return <AppShell online={online} role="Chauffeur" title={titles[page]} subtitle="Console conducteur" nav={nav} active={page} onNavigate={id => navigate('/' + id)}><SessionPanel />{page === 'route' ? <RouteScreen /> : page === 'earnings' ? <Earnings /> : <Profile />}</AppShell>;
}
