import { useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { AppShell, Card, Badge, SectionTitle, SessionPanel, EmptyState } from '@leroutier/ui';
import { useSession } from '@leroutier/config/client';
import { Trips, Tickets, Stations, Tracking, Account, Parcels as PassengerParcels, ParcelTracking, OnboardingPage, PrivacyCenter } from '@leroutier/screens/passenger';
import { Checkout } from '@leroutier/screens/checkout';
import { Today as CrewToday, Manifest, Scanner, WalkUp, Parcels as CrewParcels, Vehicle, Points, Earnings, Profile } from '@leroutier/screens/crew';
import { Today as OpsToday, Services, Fleet, Crew, Stations as OpsStations, Parcels as OpsParcels, Payments, Settlements, Incidents, Alerts, Settings } from '@leroutier/screens/ops';
import { PlatformOverview, PlatformOperators, PlatformVerification, PlatformUsers, PlatformFinance, PlatformIncidents, PlatformSystem } from '@leroutier/screens/platform-ops';
import { JourneyTimeline } from '@leroutier/screens/journey';
import { JourneyTracking } from '@leroutier/screens/tracking';
import { NotificationCentre, useUnreadCount } from '@leroutier/screens/notifications';
import { Home } from './home.jsx';
import { PASSENGER, WORK, OPS, workspacesFor, capabilities, workspaceOf, isAuthorized } from './workspaces.js';
import {
  Search, Ticket, UserRound, Package, Bell, Home as HomeIcon, Route, Users, QrCode,
  Wallet, BusFront, MapPin, Radio, WalletCards, ShieldAlert, Settings as SettingsIcon, Layers, Lock, LogOut, ShieldCheck, Building2, Database,
} from 'lucide-react';

function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function TicketsRoute() {
  const { id } = useParams();
  return <div className="stack">
    <Tickets focusId={id}/>
    {id && <JourneyTracking bookingId={id}/>}
    {id && <JourneyTimeline bookingId={id}/>}
  </div>;
}

function ParcelsRoute() {
  const { id } = useParams();
  return id === 'track' ? <ParcelTracking/> : <PassengerParcels/>;
}

function NotAuthorized({ workspace }) {
  return <EmptyState icon={Lock} title="Espace non autorisé"
    text={workspace === OPS
      ? 'Votre identité LeRoutier n’a pas d’accès exploitation. Un administrateur de la compagnie doit vous provisionner.'
      : 'Votre identité LeRoutier n’est pas encore rattachée à un opérateur comme chauffeur ou convoyeur. Passez par « Devenir opérateur ».'}/>;
}

function SignInRequired() {
  const navigate = useNavigate();
  return <div className="stack">
    <Card className="stack">
      <SectionTitle title="Connexion requise"/>
      <p className="small muted">Une seule identité LeRoutier donne accès à tous vos espaces autorisés. Vous reviendrez ici après la connexion.</p>
    </Card>
    <SessionPanel onWorkspace={navigate}/>
  </div>;
}

function AccountMenu() {
  const { user, logout } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const initials = user?.display_name
    ? user.display_name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : '';
  return <div className="account-menu-wrap">
    <button className="avatar-btn" aria-label={user ? `Compte de ${user.display_name}` : 'Se connecter'}
      aria-expanded={open} onClick={() => { if (user) setOpen(o => !o); else navigate('/account'); }}>
      {user && initials ? <span className="avatar" aria-hidden="true">{initials}</span> : <UserRound size={19} aria-hidden="true"/>}
    </button>
    {open && user && <div className="account-menu" role="menu" aria-label="Menu du compte">
      <button role="menuitem" onClick={() => { setOpen(false); navigate('/account'); }}><UserRound size={15}/>Mon profil</button>
      <button role="menuitem" onClick={() => { setOpen(false); navigate('/account/privacy'); }}><ShieldCheck size={15}/>Confidentialité et données</button>
      <button role="menuitem" onClick={async () => { setOpen(false); await logout(); }}><LogOut size={15}/>Déconnexion</button>
    </div>}
  </div>;
}

function WorkspaceSwitcher({ current, onSwitch }) {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const available = workspacesFor(user);
  if (available.length < 2) return null;
  return <>
    <button className="workspace-switch" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label="Changer d’espace">
      <Layers size={15}/>{available.find(w => w.id === current)?.label ?? 'Espaces'}
    </button>
    {open && <div className="workspace-menu" role="menu" style={{ position: 'absolute', top: 68, right: 18, zIndex: 60, width: 260 }}>
      {available.map(workspace => <button key={workspace.id} role="menuitem" className={workspace.id === current ? 'active' : ''}
        onClick={() => { setOpen(false); onSwitch(workspace.path); }}>
        {workspace.label}<small>{workspace.hint}</small>
      </button>)}
    </div>}
  </>;
}

export default function App() {
  const { online, user, authLoading } = useSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const unread = useUnreadCount();
  const can = capabilities(user);
  const workspace = workspaceOf(pathname);
  const segments = trimTrailingSlashes(pathname).split('/').filter(Boolean);

  const passengerNav = [
    { id: 'trips', label: 'Voyager', icon: Search },
    { id: 'tickets', label: 'Billets', icon: Ticket },
    { id: 'parcels', label: 'Colis', icon: Package },
    { id: 'notifications', label: 'Alertes', icon: Bell },
    { id: 'account', label: 'Compte', icon: UserRound },
  ];
  const passengerScreens = {
    '': <Home/>, trips: <Trips/>, tickets: <TicketsRoute/>, stations: <Stations/>, parcels: <ParcelsRoute/>,
    tracking: <Tracking/>, account: <Account/>, onboarding: <OnboardingPage/>, checkout: <Checkout/>,
    notifications: <NotificationCentre onOpen={to => navigate(to)}/>,
  };
  const passengerTitles = {
    '': 'LeRoutier', trips: 'Voyager', tickets: 'Mes billets', stations: 'Gares & arrêts',
    parcels: 'Colis', tracking: 'Suivi', account: 'Mon compte', onboarding: 'Travailler avec LeRoutier',
    checkout: 'Paiement', notifications: 'Notifications',
  };

  const workNav = [
    { id: 'today', label: can.convoyeur ? 'Service' : 'Aujourd’hui', icon: Route },
    { id: 'manifest', label: 'Manifeste', icon: Users },
    { id: 'scanner', label: 'Scanner', icon: QrCode },
    { id: 'walk-up', label: 'Comptant', icon: Wallet },
    { id: 'parcels', label: 'Colis', icon: Package },
    ...(can.role === 'driver' ? [{ id: 'vehicle', label: 'Véhicule', icon: BusFront }] : []),
    ...(can.independent ? [{ id: 'boarding-points', label: 'Points', icon: MapPin }, { id: 'earnings', label: 'Recettes', icon: Wallet }] : []),
    { id: 'profile', label: 'Profil', icon: UserRound },
  ];
  const workScreens = {
    today: <CrewToday/>, manifest: <Manifest/>, scanner: <Scanner/>, 'walk-up': <WalkUp/>, parcels: <CrewParcels/>,
    vehicle: <Vehicle/>, 'boarding-points': <Points/>, earnings: <Earnings/>, profile: <Profile/>,
    notifications: <NotificationCentre onOpen={to => navigate(to)}/>,
  };
  const workTitles = {
    today: can.convoyeur ? 'Service & point de service' : 'Aujourd’hui', manifest: 'Manifeste passagers',
    scanner: 'Contrôle des billets', 'walk-up': 'Vente au comptant', parcels: 'Colis & fret', vehicle: 'Véhicule',
    'boarding-points': 'Points d’embarquement', earnings: 'Recettes & retraits', profile: 'Profil', notifications: 'Notifications',
  };

  const companyOpsNav = [
    { id: 'today', label: 'Aujourd’hui', icon: HomeIcon }, { id: 'services', label: 'Services', icon: Radio },
    { id: 'fleet', label: 'Flotte', icon: BusFront }, { id: 'crew', label: 'Équipage', icon: Users },
    { id: 'stations', label: 'Stations', icon: MapPin }, { id: 'parcels', label: 'Colis', icon: Package },
    { id: 'payments', label: 'Paiements', icon: WalletCards }, { id: 'settlements', label: 'Règlements', icon: Wallet },
    { id: 'incidents', label: 'Incidents', icon: ShieldAlert }, { id: 'alerts', label: 'Alertes', icon: Bell },
    { id: 'settings', label: 'Paramètres', icon: SettingsIcon },
  ];
  const companyOpsScreens = {
    today: <OpsToday/>, services: <Services/>, fleet: <Fleet/>, crew: <Crew/>, stations: <OpsStations/>,
    parcels: <OpsParcels/>, payments: <Payments/>, settlements: <Settlements/>, incidents: <Incidents/>,
    alerts: <Alerts/>, settings: <Settings/>, notifications: <NotificationCentre onOpen={to => navigate(to)}/>,
  };
  const companyOpsTitles = {
    today: 'Aujourd’hui', services: 'Services & lignes', fleet: 'Flotte & véhicules', crew: 'Équipage & personnel',
    stations: 'Stations & points', parcels: 'Colis & fret', payments: 'Paiements', settlements: 'Règlements & retraits',
    incidents: 'Incidents', alerts: 'Alertes & approbations', settings: 'Paramètres', notifications: 'Notifications',
  };

  const platformOpsNav = [
    { id: 'platform', label: 'Vue plateforme', icon: HomeIcon },
    { id: 'operators', label: 'Opérateurs', icon: Building2 },
    { id: 'verification', label: 'Vérifications', icon: ShieldCheck },
    { id: 'users', label: 'Utilisateurs', icon: Users },
    { id: 'services', label: 'Services', icon: Radio },
    { id: 'parcels', label: 'Colis', icon: Package },
    { id: 'platform-incidents', label: 'Incidents', icon: ShieldAlert },
    { id: 'finance', label: 'Finances', icon: WalletCards },
    { id: 'system', label: 'Système', icon: Database },
  ];
  const platformOpsScreens = {
    platform: <PlatformOverview/>, operators: <PlatformOperators/>, verification: <PlatformVerification/>, users: <PlatformUsers/>,
    services: <Services/>, parcels: <OpsParcels/>, 'platform-incidents': <PlatformIncidents/>, finance: <PlatformFinance/>, system: <PlatformSystem/>,
    notifications: <NotificationCentre onOpen={to => navigate(to)}/>,
  };
  const platformOpsTitles = {
    platform: 'Vue plateforme', operators: 'Opérateurs', verification: 'Vérifications & KYC', users: 'Utilisateurs & authentifications',
    services: 'Services', parcels: 'Colis', 'platform-incidents': 'Incidents plateforme', finance: 'Finances & anomalies', system: 'Système & capacité', notifications: 'Notifications',
  };

  const opsNav=can.platformOps?platformOpsNav:companyOpsNav;
  const opsScreens=can.platformOps?platformOpsScreens:companyOpsScreens;
  const opsTitles=can.platformOps?platformOpsTitles:companyOpsTitles;
  const scoped = workspace === PASSENGER ? { nav: passengerNav, screens: passengerScreens, titles: passengerTitles, prefix: '', role: 'Voyageur' }
    : workspace === WORK ? { nav: workNav, screens: workScreens, titles: workTitles, prefix: '/work', role: can.convoyeur ? 'Convoyeur' : can.independent ? 'Chauffeur propriétaire' : 'Chauffeur' }
      : { nav: opsNav, screens: opsScreens, titles: opsTitles, prefix: '/ops', role: can.platformOps?'Exploitation plateforme':'Exploitation compagnie' };
  const fallbackPage=workspace===PASSENGER?'':workspace===OPS&&can.platformOps?'platform':'today';
  const page = (workspace === PASSENGER ? segments[0] : segments[1]) ?? fallbackPage;
  const privacySub = workspace === PASSENGER && page === 'account' && segments[1] === 'privacy';
  const known = Object.hasOwn(scoped.screens, page);

  const shell = content => <AppShell
    online={online} role={scoped.role} title={scoped.titles[page] ?? 'LeRoutier'} subtitle={can.platformOps&&workspace===OPS?'LeRoutier · Supervision plateforme':'LeRoutier · Bénin'}
    nav={scoped.nav} active={page} onNavigate={id => navigate(trimTrailingSlashes(`${scoped.prefix}/${id}`) || '/')}
    unread={unread} onNotifications={() => navigate(`${scoped.prefix}/notifications`)} onHome={() => navigate('/')}
    avatar={<AccountMenu/>}
    actions={<WorkspaceSwitcher current={workspace} onSwitch={path => navigate(path)}/>}>
    {content}
  </AppShell>;

  if (!known) return <Navigate to={workspace===OPS&&can.platformOps?'/ops/platform':scoped.prefix || '/'} replace/>;
  if (workspace !== PASSENGER) {
    if (authLoading) return shell(<Card><p role="status">Vérification de votre identité…</p></Card>);
    if (!user) return shell(<SignInRequired/>);
    if (!isAuthorized(workspace, user)) return shell(<NotAuthorized workspace={workspace}/>);
    if (workspace === WORK && ((page === 'boarding-points' && !can.independent) || (page === 'vehicle' && can.convoyeur))) {
      return shell(<EmptyState icon={Lock} title="Action réservée" text="Cette fonction n’est pas disponible pour votre mission."
        action={<button className="btn btn-primary" onClick={()=>navigate('/work/today')}>Revenir à mon service</button>}/>);
    }
    if (workspace === OPS && !can.platformOps && !can.verified) {
      return shell(<div className="stack">
        <Card><div className="between wrap"><span className="small">Compagnie en cours de vérification.</span><Badge tone="warning">en attente</Badge></div></Card>
        {scoped.screens[page]}
      </div>);
    }
  }
  const fullyPublic = workspace === PASSENGER && (page === '' || page === 'trips' ||
    (page === 'parcels' && segments[1] === 'track') || page === 'checkout');
  return shell(<>{user?.is_demo && <div className="notice" role="status">Espace TEST · données de démonstration · aucun paiement réel</div>}{!fullyPublic && <SessionPanel onWorkspace={navigate}/>}{privacySub ? <PrivacyCenter/> : scoped.screens[page]}</>);
}
