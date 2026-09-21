import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '@leroutier/config/client';
import { Badge, Card, EmptyState, SectionTitle } from '@leroutier/ui';
import { Building2, CarFront, ShieldCheck, UserRound } from 'lucide-react';

const input = (label, value, setValue, props = {}) => <label className="field">{label}
  <input className="control" value={value} onChange={e=>setValue(e.target.value)} {...props}/>
</label>;

export function OnboardingPage(){
  const {user,request,refresh,online}=useSession();
  const navigate=useNavigate();
  const [path,setPath]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [displayName,setDisplayName]=useState(user?.display_name||''),[phone,setPhone]=useState(user?.phone||''),[country,setCountry]=useState('BJ');
  const [legalName,setLegalName]=useState(''),[registrationRef,setRegistrationRef]=useState(''),[taxReference,setTaxReference]=useState('');
  const [representativeName,setRepresentativeName]=useState(''),[representativeIdReference,setRepresentativeIdReference]=useState('');
  const [transportAuthorizationReference,setTransportAuthorizationReference]=useState(''),[registeredAddress,setRegisteredAddress]=useState('');
  const [idDocumentType,setIdDocumentType]=useState('national_id'),[idDocumentReference,setIdDocumentReference]=useState(''),[licenseReference,setLicenseReference]=useState('');
  const [insuranceReference,setInsuranceReference]=useState(''),[roadworthinessReference,setRoadworthinessReference]=useState('');
  const [driverPhotoUrl,setDriverPhotoUrl]=useState(''),[vehicleRegistration,setVehicleRegistration]=useState(''),[vehicleCapacity,setVehicleCapacity]=useState('');
  const [vehicleMake,setVehicleMake]=useState(''),[vehicleModel,setVehicleModel]=useState(''),[vehicleColor,setVehicleColor]=useState(''),[vehicleYear,setVehicleYear]=useState(''),[vehiclePhotoUrl,setVehiclePhotoUrl]=useState('');

  if(!user) return <EmptyState icon={UserRound} title="Connexion requise" text="Connectez-vous avant de demander un espace opérateur."/>;
  if(user.role!=='passenger') return <Card className="stack"><SectionTitle title="Espace opérateur déjà créé" icon={ShieldCheck}/><p>Votre compte possède déjà un rôle opérationnel.</p><button className="btn btn-primary" onClick={()=>navigate(user.role==='ops'?'/ops/today':'/work/today')}>Ouvrir mon espace</button></Card>;

  async function submit(e){
    e.preventDefault(); setBusy(true); setError(''); setNotice('');
    try{
      if(path==='company'){
        await request('/onboarding/company',{method:'POST',key:'onboard-'+crypto.randomUUID(),body:{
          displayName,legalName,contactPhone:phone,country,registrationRef,taxReference,representativeName,representativeIdReference,
          transportAuthorizationReference,registeredAddress,
        }});
      }else{
        await request('/onboarding/independent',{method:'POST',key:'onboard-'+crypto.randomUUID(),body:{
          displayName,phone,country,idDocumentType,idDocumentReference,licenseReference,driverPhotoUrl:driverPhotoUrl||undefined,
          transportAuthorizationReference,insuranceReference,roadworthinessReference,vehicleRegistration,vehicleCapacity:Number(vehicleCapacity),
          vehicleMake,vehicleModel,vehicleColor,vehicleYear:vehicleYear?Number(vehicleYear):undefined,vehiclePhotoUrl:vehiclePhotoUrl||undefined,
        }});
      }
      await refresh(); setNotice('Dossier créé. LeRoutier doit maintenant vérifier les informations avant activation.');
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }

  if(!path) return <div className="stack">
    <SectionTitle title="Travailler avec LeRoutier" icon={ShieldCheck}/>
    <Card className="stack"><h2>Choisissez votre situation</h2><p className="muted">La vérification n’est pas la même pour une compagnie et pour un chauffeur indépendant.</p></Card>
    <div className="cards-grid">
      <Card className="stack"><Building2 size={28}/><h3>Compagnie de transport</h3><p>LeRoutier vérifie la société, son représentant légal et ses autorisations. Les chauffeurs employés par la compagnie ne doivent pas transmettre leur pièce d’identité à LeRoutier.</p><button className="btn btn-primary" onClick={()=>setPath('company')}>Enregistrer ma compagnie</button></Card>
      <Card className="stack"><CarFront size={28}/><h3>Chauffeur indépendant</h3><p>Vous êtes à la fois opérateur et conducteur. Nous vérifions donc votre identité, votre permis, vos autorisations et votre véhicule.</p><button className="btn btn-primary" onClick={()=>setPath('independent')}>Devenir chauffeur indépendant</button></Card>
    </div>
  </div>;

  return <form className="stack" onSubmit={submit}>
    <div className="between wrap"><SectionTitle title={path==='company'?'Vérification de la compagnie':'Vérification du chauffeur indépendant'} icon={path==='company'?Building2:CarFront}/><button type="button" className="btn btn-soft" onClick={()=>setPath(null)}>Changer</button></div>
    <Card className="stack"><Badge tone="warning">Vérification manuelle requise</Badge>
      <p className="small muted">Les références sont examinées par l’exploitation LeRoutier. Aucun compte opérateur ne devient « vérifié » automatiquement.</p>
    </Card>
    {path==='company'?<>
      <Card className="stack"><h3>Identité légale de la société</h3>
        {input('Nom affiché sur LeRoutier',displayName,setDisplayName,{required:true,maxLength:200})}
        {input('Raison sociale / nom légal',legalName,setLegalName,{required:true,maxLength:200})}
        {input('Téléphone de contact',phone,setPhone,{required:true,placeholder:'+229 ...'})}
        {input('Pays',country,setCountry,{required:true,maxLength:2})}
        {input('RCCM / référence d’immatriculation',registrationRef,setRegistrationRef,{required:true})}
        {input('Référence fiscale / IFU',taxReference,setTaxReference,{required:true})}
        {input('Adresse officielle',registeredAddress,setRegisteredAddress,{required:true,maxLength:500})}
      </Card>
      <Card className="stack"><h3>Responsable légal et autorisation de transport</h3>
        {input('Nom du représentant légal',representativeName,setRepresentativeName,{required:true})}
        {input('Référence de la pièce du représentant',representativeIdReference,setRepresentativeIdReference,{required:true})}
        {input('Référence de l’autorisation / licence de transport',transportAuthorizationReference,setTransportAuthorizationReference,{required:true})}
        <p className="small muted">Les chauffeurs de la compagnie restent sous la responsabilité de la compagnie vérifiée. LeRoutier ne leur demande pas de pièce d’identité individuelle pour l’activation de la compagnie.</p>
      </Card>
    </>:<>
      <Card className="stack"><h3>Identité du chauffeur</h3>
        {input('Nom complet',displayName,setDisplayName,{required:true,maxLength:200})}
        {input('Téléphone',phone,setPhone,{required:true,placeholder:'+229 ...'})}
        {input('Pays',country,setCountry,{required:true,maxLength:2})}
        <label className="field">Type de pièce d’identité<select className="control" value={idDocumentType} onChange={e=>setIdDocumentType(e.target.value)}><option value="national_id">Carte nationale d’identité</option><option value="passport">Passeport</option><option value="residence_permit">Titre de séjour</option><option value="other">Autre document officiel</option></select></label>
        {input('Référence de la pièce d’identité',idDocumentReference,setIdDocumentReference,{required:true})}
        {input('Référence du permis de conduire',licenseReference,setLicenseReference,{required:true})}
        {input('Autorisation / licence de transport',transportAuthorizationReference,setTransportAuthorizationReference,{required:true})}
        {input('Photo du chauffeur (URL HTTPS)',driverPhotoUrl,setDriverPhotoUrl,{type:'url',placeholder:'https://…'})}
        <p className="small muted">La photo validée sera montrée aux voyageurs afin qu’ils puissent reconnaître le chauffeur indépendant.</p>
      </Card>
      <Card className="stack"><h3>Véhicule et preuves</h3>
        {input('Immatriculation',vehicleRegistration,setVehicleRegistration,{required:true})}
        {input('Marque',vehicleMake,setVehicleMake,{required:true,placeholder:'Toyota'})}
        {input('Modèle',vehicleModel,setVehicleModel,{required:true,placeholder:'Hiace'})}
        {input('Couleur',vehicleColor,setVehicleColor,{required:true})}
        {input('Année',vehicleYear,setVehicleYear,{type:'number',min:1980,max:new Date().getFullYear()+1})}
        {input('Nombre de places',vehicleCapacity,setVehicleCapacity,{required:true,type:'number',min:1,max:100})}
        {input('Référence assurance',insuranceReference,setInsuranceReference,{required:true})}
        {input('Référence contrôle technique',roadworthinessReference,setRoadworthinessReference,{required:true})}
        {input('Photo du véhicule (URL HTTPS)',vehiclePhotoUrl,setVehiclePhotoUrl,{type:'url',placeholder:'https://…'})}
        <p className="small muted">Après validation, la marque, le modèle, la couleur et l’immatriculation seront clairement affichés aux voyageurs avec le trajet.</p>
      </Card>
    </>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <button className="btn btn-primary" disabled={!online||busy} type="submit">{busy?'Envoi du dossier…':'Envoyer le dossier pour vérification'}</button>
  </form>;
}
