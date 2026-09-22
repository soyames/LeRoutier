import { useState } from 'react';
import { useSession } from '@leroutier/config/client';
import { Card } from './shell.jsx';
import { SkeletonCards, ErrorState } from './states.jsx';

function isDriverApp(role){return Array.isArray(role)?role.includes('driver')||role.includes('convoyeur'):role==='driver';}

// One authentication entry for every workspace: Google or email/password,
// both converging on the same LeRoutier identity. Passwords live in Firebase
// only — the LeRoutier API never sees them.
export function SessionPanel({onWorkspace=undefined}) {
  const {user,identity,role,login,loginDemo,logout,demoLogin,configured,online,authLoading,authError,canSignin,
    createAccount,loginEmail,resetPassword}=useSession();
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [mode,setMode]=useState('signin'); // signin | register | reset
  const [email,setEmail]=useState(''),[password,setPassword]=useState('');
  const [regName,setRegName]=useState(''),[regPhone,setRegPhone]=useState('');
  async function run(action){setBusy(true);setError('');setNotice('');
    try{await action();}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function submitSignin(e){e.preventDefault();setBusy(true);setError('');
    try{await loginEmail({email,password});}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function submitRegister(e){e.preventDefault();setBusy(true);setError('');setNotice('');
    try{await createAccount({email,password,displayName:regName,phone:regPhone});}
    catch(e){setError(e.message);}finally{setBusy(false);}}
  async function submitReset(e){e.preventDefault();setBusy(true);setError('');setNotice('');
    try{setNotice(await resetPassword(email));}catch(e){setError(e.message);}finally{setBusy(false);}}
  if(!configured) return <Card><p role="status">Connexion au service indisponible. Réessayez ultérieurement.</p></Card>;
  return <Card className="stack">
    {!online && <p role="status">Hors ligne : les actions nécessitent une connexion.</p>}
    {identity ? <><div className="between"><span>{identity.display_name || 'Compte connecté'}</span><button className="btn btn-soft" disabled={busy} onClick={()=>run(logout)}>Déconnexion</button></div>
      {!user && <p role="status">
        {isDriverApp(role) && identity.role==='convoyeur' && 'Votre compte convoyeur est actif : utilisez la console Conducteur en mode convoyeur.'}
        {isDriverApp(role) && identity.role==='ops' && 'Votre compte administrateur s’utilise dans le centre opérationnel (app Ops), pas dans la console conducteur.'}
        {isDriverApp(role) && identity.role==='passenger' && 'Votre compte passager n’est pas encore provisionné comme équipage. Créez un compte opérateur ou demandez votre provisionnement.'}
        {role==='ops' && identity.role==='passenger' && 'Cet espace est réservé aux opérateurs de transport.'}
        {role==='ops' && identity.role==='driver' && 'Votre compte chauffeur s’utilise dans la console Conducteur, pas dans le centre opérationnel.'}
      </p>}
      {user?.needs_profile && <ProfileForm/>}</> : <>
      <h3>Bienvenue sur LeRoutier</h3>
      {authLoading ? <p role="status">Connexion en cours…</p> : <>
        <button className="btn btn-primary" disabled={busy || !online || !canSignin} onClick={()=>run(login)}>
          {canSignin?'Continuer avec Google':'Connexion indisponible'}</button>
        {!canSignin && !demoLogin && <p role="status">La connexion sécurisée n’est pas encore configurée.</p>}
        {demoLogin && <button className="btn btn-soft" disabled={busy || !online} onClick={()=>run(loginDemo)}>Connexion de développement</button>}
        {demoLogin && Array.isArray(role) && role.length>1 && <div className="controls">
          {role.map(r=><button key={r} className="control" disabled={busy || !online}
            onClick={()=>run(()=>loginDemo(r))}>Développement : {r}</button>)}
        </div>}
        {demoLogin && <details className="stack"><summary>Profils TEST : tous les espaces</summary>
          <p className="small muted">Données de démonstration locales. Aucun paiement réel.</p>
          <div className="demo-profiles">{[
            ['passenger','Voyageur','/tickets'],['owner-driver','Chauffeur indépendant','/work/today'],
            ['company-driver','Conducteur de compagnie','/work/today'],['convoyeur','Convoyeur','/work/today'],
            ['company-ops','Exploitation compagnie','/ops/today'],['platform-ops','Exploitation plateforme','/ops/today'],
          ].map(([profile,label,path])=><button key={profile} className="btn btn-soft" disabled={busy || !online}
            onClick={()=>run(async()=>{await loginDemo({profile});onWorkspace?.(path);})}>TEST : {label}</button>)}</div>
        </details>}
        {canSignin && mode==='signin' && <form className="stack" onSubmit={submitSignin}>
          <p className="small muted">ou</p>
          <label>Adresse e-mail<input className="control" type="email" autoComplete="email" required maxLength={255} value={email} onChange={e=>setEmail(e.target.value)}/></label>
          <label>Mot de passe<input className="control" type="password" autoComplete="current-password" required minLength={6} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></label>
          <button className="btn btn-soft" disabled={busy || !online}>Se connecter avec mon adresse e-mail</button>
          <div className="between wrap">
            <button type="button" className="footer-link" onClick={()=>{setMode('reset');setNotice('');setError('');}}>Mot de passe oublié ?</button>
            <button type="button" className="footer-link" onClick={()=>{setMode('register');setNotice('');setError('');}}>Pas encore de compte ? Créer un compte</button>
          </div>
        </form>}
        {canSignin && mode==='register' && <form className="stack" onSubmit={submitRegister}>
          <h3>Créer un compte</h3>
          <label>Nom complet<input className="control" autoComplete="name" required minLength={2} maxLength={100} value={regName} onChange={e=>setRegName(e.target.value)}/></label>
          <label>Téléphone<input className="control" type="tel" autoComplete="tel" maxLength={30} value={regPhone} onChange={e=>setRegPhone(e.target.value)}/></label>
          <label>Adresse e-mail<input className="control" type="email" autoComplete="email" required maxLength={255} value={email} onChange={e=>setEmail(e.target.value)}/></label>
          <label>Mot de passe<input className="control" type="password" autoComplete="new-password" required minLength={6} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></label>
          <button className="btn btn-primary" disabled={busy || !online}>Créer mon compte</button>
          <button type="button" className="footer-link" onClick={()=>{setMode('signin');setNotice('');setError('');}}>J’ai déjà un compte</button>
          <p className="small muted">En créant un compte, vous acceptez nos <a href="/terms">conditions d’utilisation</a> et notre <a href="/privacy">politique de confidentialité</a>.</p>
        </form>}
        {canSignin && mode==='reset' && <form className="stack" onSubmit={submitReset}>
          <h3>Mot de passe oublié ?</h3>
          <p className="small muted">Nous vous enverrons un lien de réinitialisation à cette adresse.</p>
          <label>Adresse e-mail<input className="control" type="email" autoComplete="email" required maxLength={255} value={email} onChange={e=>setEmail(e.target.value)}/></label>
          <button className="btn btn-soft" disabled={busy || !online}>Envoyer le lien</button>
          <button type="button" className="footer-link" onClick={()=>{setMode('signin');setNotice('');setError('');}}>Retour à la connexion</button>
        </form>}
      </>}
      {notice && <p role="status">{notice}</p>}
      {!authLoading && !canSignin && !demoLogin && mode==='signin' && <p className="small muted">Connectez-vous pour réserver un trajet, suivre vos billets et envoyer des colis.</p>}
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

/**
 * Loading / error / empty for one API resource.
 * `skeleton` shapes the placeholder; `title` and `action` turn an empty result
 * into a next step instead of a dead end.
 * @param {{ resource: any, empty?: string, emptyTitle?: string, action?: import('react').ReactNode, skeleton?: number, errorText?: string }} props
 */
export function ApiState({resource,empty='Aucune donnée disponible.',emptyTitle,action,skeleton=2,errorText}) {
  if(resource.loading) return <SkeletonCards count={skeleton}/>;
  if(resource.error) return <ErrorState text={errorText || resource.error} onRetry={resource.reload}/>;
  if(!empty && !emptyTitle) return null;
  return <Card className="stack empty-inline">
    {emptyTitle && <strong>{emptyTitle}</strong>}
    <p className="small muted" role="status">{empty}</p>
    {action && <div className="controls">{action}</div>}
  </Card>;
}
