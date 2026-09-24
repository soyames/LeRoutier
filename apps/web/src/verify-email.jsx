import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '@leroutier/config/client';
import { applyVerificationCode } from '@leroutier/config/firebase';
import { Card } from '@leroutier/ui';

/**
 * The branded destination of the account-verification email:
 * /verify-email?oobCode=…
 *
 * The oobCode is Firebase's own email-verification action code, generated
 * server-side by the Admin SDK and delivered through Brevo. Applying it is
 * Firebase's supported client mechanism — the public web identifiers, nothing
 * else — and it is what flips the email_verified claim the API gate reads.
 * No secret ever reaches this route, and an invalid, expired or already-used
 * code produces an honest screen with the way back, never a new account.
 */
export function VerifyEmail(){
  const {firebase,authLoading}=useSession();
  // Read ONCE: the success handler clears the code from the address bar, and
  // a value re-read on every render would turn "confirmed" back into
  // "invalid" the moment the URL is cleaned.
  const [code]=useState(()=>new URLSearchParams(window.location.search).get('oobCode'));
  const [state,setState]=useState(code?'applying':'invalid'); // applying | confirmed | invalid | disabled
  useEffect(()=>{
    if(!code || !firebase) return;
    let cancelled=false;
    applyVerificationCode(firebase,code).then(()=>{
      if(cancelled)return;
      setState('confirmed');
      // The code is single-use; do not leave it in the address bar.
      try{ window.history.replaceState({},'',window.location.pathname); }catch{ /* cosmetic */ }
    }).catch(error=>{
      if(cancelled)return;
      setState(error?.code==='auth/user-disabled'?'disabled':'invalid');
    });
    return()=>{cancelled=true;};
  },[firebase,code]);
  // A missing code — or no Firebase configuration at all, once the published
  // config has loaded — reads exactly like an invalid code: no secrets, an
  // honest refusal, and the way back to sign-in.
  const view=!code || (!firebase && !authLoading) ? 'invalid' : state;
  return <div className="stack center-page"><Card className="stack center">
    {view==='applying' && <p role="status" aria-live="polite">Confirmation en cours…</p>}
    {view==='confirmed' && <>
      <h2>Votre adresse e-mail est confirmée.</h2>
      <p>Vous pouvez maintenant vous connecter à LeRoutier.</p>
      <Link className="btn btn-primary" to="/account">Se connecter</Link>
    </>}
    {view==='invalid' && <>
      <h2>Lien de confirmation invalide</h2>
      <p role="alert">Ce lien n’est plus valide : il a expiré ou a déjà été utilisé. Connectez-vous avec votre adresse e-mail : un nouveau lien pourra être renvoyé.</p>
      <Link className="btn btn-primary" to="/account">Se connecter</Link>
    </>}
    {view==='disabled' && <>
      <h2>Confirmation impossible</h2>
      <p role="alert">Ce compte a été désactivé. Contactez LeRoutier.</p>
    </>}
  </Card></div>;
}
