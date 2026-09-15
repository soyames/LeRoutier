import { AppShell, SessionPanel } from '@leroutier/ui';
import { useSession } from '@leroutier/config/client';
import { Dashboard } from './screens.jsx';
import { useState } from 'react';
import { Provisioning } from './provisioning.jsx';
export default function App(){
 const {online}=useSession(),[revision,setRevision]=useState(0);
 return <AppShell online={online} role="Régulation" title="Flotte & supervision réseau" subtitle="Centre opérationnel"><SessionPanel/><Provisioning onSaved={()=>setRevision(n=>n+1)}/><Dashboard key={revision}/></AppShell>;
}
