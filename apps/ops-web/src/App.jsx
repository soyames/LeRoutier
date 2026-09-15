import { Navigate, useLocation, useNavigate } from 'react-router';
import { AppShell, SessionPanel } from '@leroutier/ui';
import { useSession } from '@leroutier/config/client';
import { Today, Services, Fleet, Crew, Stations, Parcels, Payments, Settlements, Incidents, Alerts, Settings } from './screens.jsx';
import { Home, Radio, BusFront, Users, MapPin, Package, WalletCards, Wallet, ShieldAlert, Bell, Settings as SettingsIcon } from 'lucide-react';
const nav=[
  {id:'today',label:'Aujourd’hui',icon:Home},{id:'services',label:'Services',icon:Radio},{id:'fleet',label:'Flotte',icon:BusFront},
  {id:'crew',label:'Équipage',icon:Users},{id:'stations',label:'Stations',icon:MapPin},{id:'parcels',label:'Colis',icon:Package},
  {id:'payments',label:'Paiements',icon:WalletCards},{id:'settlements',label:'Règlements',icon:Wallet},
  {id:'incidents',label:'Incidents',icon:ShieldAlert},{id:'alerts',label:'Alertes',icon:Bell},{id:'settings',label:'Paramètres',icon:SettingsIcon},
];
const titles={today:'Aujourd’hui',services:'Services & lignes',fleet:'Flotte & véhicules',crew:'Équipage & personnel',stations:'Stations & points',parcels:'Colis & fret',payments:'Paiements',settlements:'Règlements & retraits',incidents:'Incidents',alerts:'Alertes & approbations',settings:'Paramètres'};
export default function App(){
  const {online}=useSession();
  const {pathname}=useLocation();
  const navigate=useNavigate();
  const page=pathname.replace(/\/$/,'').slice(1)||'today';
  if(!Object.hasOwn(titles,page)) return <Navigate to="/" replace/>;
  const screens={today:<Today/>,services:<Services/>,fleet:<Fleet/>,crew:<Crew/>,stations:<Stations/>,parcels:<Parcels/>,payments:<Payments/>,settlements:<Settlements/>,incidents:<Incidents/>,alerts:<Alerts/>,settings:<Settings/>};
  return <AppShell online={online} role="Opérateur" title={titles[page]} subtitle="Centre opérationnel LeRoutier" nav={nav} active={page} onNavigate={id=>navigate('/'+id)}><SessionPanel/>{screens[page]}</AppShell>;
}
