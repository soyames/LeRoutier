import { AppShell, SessionPanel } from '@leroutier/ui';
import { useSession } from '@leroutier/config/client';
import { Dashboard } from './screens.jsx';
export default function App(){
 const {online}=useSession();
 return <AppShell online={online} role="Régulation" title="Flotte & supervision réseau" subtitle="Centre opérationnel"><SessionPanel/><Dashboard/></AppShell>;
}
