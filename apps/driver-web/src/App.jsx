import { Navigate, useLocation, useNavigate } from 'react-router';
import { AppShell, SessionPanel } from '@leroutier/ui';
import { useSession } from '@leroutier/config/client';
import { Today, Manifest, Scanner, WalkUp, Parcels, Vehicle, Points, Earnings, Profile } from './screens.jsx';
import { Route, Users, QrCode, Wallet, Package, BusFront, MapPin, UserRound } from 'lucide-react';
export default function App() {
  const { online, user } = useSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const page = pathname.replace(/\/$/, '').slice(1) || 'today';
  const role = user?.role === 'convoyeur' ? 'convoyeur' : 'driver';
  const independent = user?.operator_type === 'independent' && user?.role === 'driver';
  const nav = [
    { id: 'today', label: role === 'convoyeur' ? 'Service' : 'Aujourd’hui', icon: Route },
    { id: 'manifest', label: 'Manifeste', icon: Users },
    { id: 'scanner', label: 'Scanner', icon: QrCode },
    { id: 'walk-up', label: 'Comptant', icon: Wallet },
    { id: 'parcels', label: 'Colis', icon: Package },
    ...(role === 'driver' ? [{ id: 'vehicle', label: 'Véhicule', icon: BusFront }] : []),
    ...(independent ? [{ id: 'points', label: 'Points', icon: MapPin }, { id: 'earnings', label: 'Gains', icon: Wallet }] : []),
    { id: 'profile', label: 'Profil', icon: UserRound },
  ];
  const titles = { today: role === 'convoyeur' ? 'Service & point de service' : 'Aujourd’hui', manifest: 'Manifeste passagers', scanner: 'Contrôle des billets', 'walk-up': 'Vente au comptant', parcels: 'Colis & fret', vehicle: 'Véhicule', points: 'Points d’embarquement', earnings: 'Gains & versements', profile: 'Profil' };
  if (!Object.hasOwn(titles, page)) return <Navigate to="/" replace />;
  const screens = { today: <Today />, manifest: <Manifest />, scanner: <Scanner />, 'walk-up': <WalkUp />, parcels: <Parcels />, vehicle: <Vehicle />, points: <Points />, earnings: <Earnings />, profile: <Profile /> };
  return <AppShell online={online} role={role === 'convoyeur' ? 'Convoyeur' : 'Chauffeur'} title={titles[page]} subtitle={independent ? 'Chauffeur indépendant LeRoutier' : 'Console conducteur LeRoutier'} nav={nav} active={page} onNavigate={id => navigate('/' + id)}><SessionPanel />{screens[page]}</AppShell>;
}
