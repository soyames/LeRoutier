import { useState } from 'react';
import { useSession } from '@leroutier/config/client';
import { Card } from './shell.jsx';

export function SessionPanel() {
  const {user,login,logout,demoLogin,configured,online}=useSession();
  const [token,setToken]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function connect(accessToken=undefined) {
    setBusy(true);setError('');
    try {await login(accessToken);setToken('');} catch(e){setError(e.message);} finally {setBusy(false);}
  }
  if(!configured) return <Card><p role="status">Connexion au service indisponible. Réessayez ultérieurement.</p></Card>;
  return <Card className="stack">
    {!online && <p role="status">Hors ligne — les actions nécessitent une connexion.</p>}
    {user ? <div className="between"><span>{user.display_name}</span><button className="btn btn-soft" onClick={logout}>Déconnexion</button></div> : <>
      <h3>Connexion</h3>
      {demoLogin ? <button className="btn btn-primary" disabled={busy || !online} onClick={()=>connect()}>Connexion de développement</button> :
        <form className="row wrap" onSubmit={e=>{e.preventDefault();connect(token);}}><label>Jeton de session <input type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)}/></label><button className="btn btn-primary" disabled={busy || !online || !token}>Se connecter</button></form>}
      <p className="small muted">Un compte autorisé est nécessaire pour réserver ou effectuer une action.</p>
    </>}
    {error && <p role="alert">{error}</p>}
  </Card>;
}
export function ApiState({resource,empty='Aucune donnée disponible.'}) {
  if(resource.loading) return <Card><p role="status">Chargement…</p></Card>;
  if(resource.error) return <Card className="stack"><p role="alert">{resource.error}</p><button className="btn btn-soft" onClick={resource.reload}>Réessayer</button></Card>;
  return <Card><p role="status">{empty}</p></Card>;
}
