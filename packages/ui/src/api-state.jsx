import { useState } from 'react';
import { useSession } from '@leroutier/config/client';
import { Card } from './shell.jsx';

function isDriverApp(role){return Array.isArray(role)?role.includes('driver')||role.includes('convoyeur'):role==='driver';}
export function SessionPanel() {
  const {user,identity,role,login,loginDemo,logout,demoLogin,configured,online,authLoading,authError,canSignin}=useSession();
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function connect(action) {
    setBusy(true);setError('');
    try {await action();} catch(e){setError(e.message);} finally {setBusy(false);}
  }
  if(!configured) return <Card><p role="status">Connexion au service indisponible. Réessayez ultérieurement.</p></Card>;
  return <Card className="stack">
    {!online && <p role="status">Hors ligne — les actions nécessitent une connexion.</p>}
    {identity ? <><div className="between"><span>{identity.display_name || 'Compte connecté'}</span><button className="btn btn-soft" disabled={busy} onClick={()=>connect(logout)}>Déconnexion</button></div>
      {!user && <p role="status">
        {isDriverApp(role) && identity.role==='convoyeur' && 'Votre compte convoyeur est actif — utilisez la console Conducteur en mode convoyeur.'}
        {isDriverApp(role) && identity.role==='ops' && 'Votre compte administrateur s’utilise dans le centre opérationnel (app Ops), pas dans la console conducteur.'}
        {isDriverApp(role) && identity.role==='passenger' && 'Votre compte passager n’est pas encore provisionné comme équipage. Créez un compte opérateur ou demandez votre provisionnement.'}
        {role==='ops' && identity.role==='passenger' && 'Votre compte passager n’a pas accès au centre opérationnel. Créez un compte opérateur (compagnie) pour administrer.'}
        {role==='ops' && identity.role==='driver' && 'Votre compte chauffeur s’utilise dans la console Conducteur, pas dans le centre opérationnel.'}
      </p>}
      {user?.needs_profile && <ProfileForm/>}</> : <>
      <h3>Connexion</h3>
      {authLoading?<p role="status">Chargement de la connexion…</p>:<>
        <button className="btn btn-primary" disabled={busy || !online || !canSignin} onClick={()=>connect(login)}>Se connecter</button>
        {!canSignin && !demoLogin && <p role="status">La connexion sécurisée n’est pas encore configurée.</p>}
        {demoLogin && <button className="btn btn-soft" disabled={busy || !online} onClick={()=>connect(loginDemo)}>Connexion de développement</button>}
        {/* The unified app serves every role from one identity: in development
            only, offer each role so a workspace can be opened directly. */}
        {demoLogin && Array.isArray(role) && role.length>1 && <div className="controls">
          {role.filter(r=>r!=='convoyeur').map(r=><button key={r} className="control" disabled={busy || !online}
            onClick={()=>connect(()=>loginDemo(r))}>Développement : {r}</button>)}
        </div>}
      </>}
      <p className="small muted">Un compte autorisé est nécessaire pour réserver ou effectuer une action.</p>
    </>}
    {(error || authError) && <p role="alert">{error || authError}</p>}
  </Card>;
}
export function ProfileForm(){
  const {user,updateProfile,online}=useSession();
  const [name,setName]=useState(user?.display_name || ''),[phone,setPhone]=useState(user?.phone || ''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  async function save(e){e.preventDefault();setBusy(true);setError('');setSaved(false);try{await updateProfile({displayName:name,phone:phone.trim() || null});setSaved(true);}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <form className="stack" onSubmit={save}><h3>{user?.needs_profile?'Complétez votre profil':'Votre profil'}</h3>
    <label>Nom complet<input className="control" autoComplete="name" required minLength={2} maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
    <label>Téléphone<input className="control" type="tel" autoComplete="tel" maxLength={30} value={phone} onChange={e=>setPhone(e.target.value)}/></label>
    <button className="btn btn-primary" disabled={busy || !online || !name.trim()}>Enregistrer mon profil</button>
    {error && <p role="alert">{error}</p>}{saved && <p role="status">Profil enregistré.</p>}
  </form>;
}
export function ApiState({resource,empty='Aucune donnée disponible.'}) {
  if(resource.loading) return <Card><p role="status">Chargement…</p></Card>;
  if(resource.error) return <Card className="stack"><p role="alert">{resource.error}</p><button className="btn btn-soft" onClick={resource.reload}>Réessayer</button></Card>;
  return <Card><p role="status">{empty}</p></Card>;
}
