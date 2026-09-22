import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi, useSession } from '@leroutier/config/client';
import { Badge, Card, EmptyState, SectionTitle, SkeletonCards } from '@leroutier/ui';
import { Building2, CarFront, ShieldCheck, UserRound } from 'lucide-react';

const field=(label,value,setValue,props={})=><label className="field">{label}<input className="control" value={value} onChange={e=>setValue(e.target.value)} {...props}/></label>;
const proof=(label,value,setValue)=>field(label,value,setValue,{required:true,type:'url',placeholder:'https://…'});

/** The same wording Platform Ops reviews under, so both sides name a proof identically. */
export const EVIDENCE_LABELS={company_registration:'Immatriculation / RCCM',tax_registration:'Fiscalité / IFU',
  legal_representative_identity:'Identité du représentant légal',transport_authorization:'Autorisation de transport',
  registered_address:'Adresse officielle',identity:'Pièce d’identité',driving_license:'Permis de conduire',
  vehicle_registration:'Immatriculation du véhicule',insurance:'Assurance',roadworthiness:'Contrôle technique',
  driver_photo:'Photo du chauffeur',vehicle_photo:'Photo du véhicule'};

/** A proof that carries no reference: only the file can be corrected. */
const PHOTO_ONLY=new Set(['driver_photo','vehicle_photo']);

function RejectedProof({evidence,onFixed}){
  const {request,online}=useSession();
  const [reference,setReference]=useState(evidence.reference??'');
  const [fileUrl,setFileUrl]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const photoOnly=PHOTO_ONLY.has(evidence.kind);
  async function submit(event){
    event.preventDefault();setBusy(true);setError('');
    try{
      await request(`/onboarding/evidence/${evidence.id}`,{method:'POST',
        body:photoOnly?{fileUrl}:{reference,fileUrl}});
      onFixed();
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <form className="stack" onSubmit={submit}>
    <div className="between wrap"><strong>{EVIDENCE_LABELS[evidence.kind]||evidence.kind}</strong><Badge tone="danger">Refusé</Badge></div>
    {/* The reviewer's reason. Without it the operator is told to fix something
        without being told what was wrong with it. */}
    <p role="alert">{evidence.notes||'Ce justificatif n’a pas été accepté. Fournissez un document lisible et en cours de validité.'}</p>
    {!photoOnly&&field('Nouvelle référence',reference,setReference,{required:true,maxLength:200})}
    {field(photoOnly?'Nouvelle photo (lien HTTPS)':'Nouveau justificatif (lien HTTPS)',fileUrl,setFileUrl,
      {required:true,type:'url',placeholder:'https://…'})}
    {error&&<p role="alert">{error}</p>}
    <button className="btn btn-primary" disabled={!online||busy}>{busy?'Envoi…':'Renvoyer ce justificatif'}</button>
  </form>;
}

/**
 * The operator's own verification file.
 *
 * This is the half of the review loop that was missing. Platform Ops could
 * refuse a proof and write a reason; the operator saw neither, and had no way
 * to submit a replacement — while the server refused verification until one
 * arrived. A dossier stuck that way could never be unstuck by anybody.
 */
export function VerificationDossier(){
  const dossier=useApi('/onboarding/evidence');
  const {user}=useSession();
  if(!user||user.role==='passenger'||user.verification_status==='verified')return null;
  if(dossier.loading)return <SkeletonCards count={1}/>;
  // Not every member of an operator may read the file; for them the banner
  // elsewhere is the whole story and this simply stays quiet.
  if(dossier.error)return null;
  const data=dossier.data;
  const rejected=(data.evidence||[]).filter(e=>e.status==='rejected');
  const correctable=new Set(data.correctable||[]);
  return <Card className="stack">
    <div className="between wrap"><strong>Votre dossier de vérification</strong>
      <Badge tone={rejected.length?'danger':'warning'}>{rejected.length?`${rejected.length} justificatif${rejected.length>1?'s':''} à corriger`:'En cours d’examen'}</Badge></div>
    {rejected.length===0&&<p className="small muted">Chaque justificatif est examiné par une personne chez LeRoutier. Vous serez prévenu dès qu’une décision est prise.</p>}
    <div className="summary">{(data.evidence||[]).map(e=><div className="row" key={e.id}>
      <span>{EVIDENCE_LABELS[e.kind]||e.kind}</span>
      <Badge tone={e.status==='verified'?'success':e.status==='rejected'?'danger':'warning'}>
        {e.status==='verified'?'Validé':e.status==='rejected'?'Refusé':'À examiner'}</Badge></div>)}</div>
    {rejected.map(e=>correctable.has(e.id)
      ? <RejectedProof key={e.id} evidence={e} onFixed={dossier.reload}/>
      : <div className="stack" key={e.id}>
        <div className="between wrap"><strong>{EVIDENCE_LABELS[e.kind]||e.kind}</strong><Badge tone="danger">Refusé</Badge></div>
        <p role="alert">{e.notes||'Ce justificatif n’a pas été accepté.'}</p>
        {/* Deliberately no form: the operator itself was refused or suspended,
            which is a decision about the operator and not about this document.
            Re-opening it is LeRoutier's, and saying so beats a button that
            would always fail. */}
        <p className="small muted">Ce dossier n’est plus en cours d’examen. Contactez LeRoutier pour le faire réexaminer.</p>
      </div>)}
  </Card>;
}

export function OnboardingPage(){
  const {user,request,refresh,online}=useSession();
  const navigate=useNavigate();
  const [path,setPath]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [displayName,setDisplayName]=useState(user?.display_name||''),[phone,setPhone]=useState(user?.phone||''),[country,setCountry]=useState('BJ');
  const [legalName,setLegalName]=useState(''),[registrationRef,setRegistrationRef]=useState(''),[taxReference,setTaxReference]=useState('');
  const [representativeName,setRepresentativeName]=useState(''),[representativeIdReference,setRepresentativeIdReference]=useState('');
  const [transportAuthorizationReference,setTransportAuthorizationReference]=useState(''),[registeredAddress,setRegisteredAddress]=useState('');
  const [registrationDocumentUrl,setRegistrationDocumentUrl]=useState(''),[taxDocumentUrl,setTaxDocumentUrl]=useState('');
  const [representativeIdDocumentUrl,setRepresentativeIdDocumentUrl]=useState(''),[transportAuthorizationDocumentUrl,setTransportAuthorizationDocumentUrl]=useState(''),[addressProofUrl,setAddressProofUrl]=useState('');
  const [idDocumentType,setIdDocumentType]=useState('national_id'),[idDocumentReference,setIdDocumentReference]=useState(''),[licenseReference,setLicenseReference]=useState('');
  const [idDocumentUrl,setIdDocumentUrl]=useState(''),[licenseDocumentUrl,setLicenseDocumentUrl]=useState('');
  const [insuranceReference,setInsuranceReference]=useState(''),[insuranceDocumentUrl,setInsuranceDocumentUrl]=useState('');
  const [roadworthinessReference,setRoadworthinessReference]=useState(''),[roadworthinessDocumentUrl,setRoadworthinessDocumentUrl]=useState('');
  const [driverPhotoUrl,setDriverPhotoUrl]=useState(''),[vehicleRegistration,setVehicleRegistration]=useState(''),[vehicleRegistrationDocumentUrl,setVehicleRegistrationDocumentUrl]=useState('');
  const [vehicleCapacity,setVehicleCapacity]=useState(''),[vehicleMake,setVehicleMake]=useState(''),[vehicleModel,setVehicleModel]=useState(''),[vehicleColor,setVehicleColor]=useState(''),[vehicleYear,setVehicleYear]=useState(''),[vehiclePhotoUrl,setVehiclePhotoUrl]=useState('');

  if(!user)return <EmptyState icon={UserRound} title="Connexion requise" text="Connectez-vous avant de demander un espace opérateur."/>;
  if(user.role!=='passenger')return <Card className="stack"><SectionTitle title="Espace opérateur déjà créé" icon={ShieldCheck}/><p>Votre compte possède déjà un rôle opérationnel.</p><button className="btn btn-primary" onClick={()=>navigate(user.role==='ops'?'/ops/today':'/work/today')}>Ouvrir mon espace</button></Card>;

  async function submit(e){
    e.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      if(path==='company')await request('/onboarding/company',{method:'POST',key:'onboard-'+crypto.randomUUID(),body:{
        displayName,legalName,contactPhone:phone,country,registrationRef,registrationDocumentUrl,taxReference,taxDocumentUrl,
        representativeName,representativeIdReference,representativeIdDocumentUrl,transportAuthorizationReference,transportAuthorizationDocumentUrl,
        registeredAddress,addressProofUrl}});
      else await request('/onboarding/independent',{method:'POST',key:'onboard-'+crypto.randomUUID(),body:{
        displayName,phone,country,idDocumentType,idDocumentReference,idDocumentUrl,licenseReference,licenseDocumentUrl,driverPhotoUrl,
        transportAuthorizationReference,transportAuthorizationDocumentUrl,insuranceReference,insuranceDocumentUrl,roadworthinessReference,roadworthinessDocumentUrl,
        vehicleRegistration,vehicleRegistrationDocumentUrl,vehicleCapacity:Number(vehicleCapacity),vehicleMake,vehicleModel,vehicleColor,
        vehicleYear:vehicleYear?Number(vehicleYear):undefined,vehiclePhotoUrl:vehiclePhotoUrl||undefined}});
      await refresh();setNotice('Dossier créé. LeRoutier doit maintenant vérifier chaque preuve avant activation.');
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }

  if(!path)return <div className="stack"><SectionTitle title="Travailler avec LeRoutier" icon={ShieldCheck}/>
    <Card className="stack"><h2>Choisissez votre situation</h2><p className="muted">La vérification n’est pas la même pour une compagnie et pour un chauffeur indépendant.</p></Card>
    <div className="cards-grid">
      <Card className="stack"><Building2 size={28}/><h3>Compagnie de transport</h3><p>LeRoutier vérifie la société, son représentant légal et ses autorisations. Les chauffeurs employés par la compagnie ne transmettent pas leur pièce d’identité à LeRoutier.</p><button className="btn btn-primary" onClick={()=>setPath('company')}>Enregistrer ma compagnie</button></Card>
      <Card className="stack"><CarFront size={28}/><h3>Chauffeur indépendant</h3><p>Vous êtes à la fois opérateur et conducteur. Nous vérifions votre identité, votre permis, vos autorisations et votre véhicule.</p><button className="btn btn-primary" onClick={()=>setPath('independent')}>Devenir chauffeur indépendant</button></Card>
    </div></div>;

  return <form className="stack" onSubmit={submit}>
    <div className="between wrap"><SectionTitle title={path==='company'?'Vérification de la compagnie':'Vérification du chauffeur indépendant'} icon={path==='company'?Building2:CarFront}/><button type="button" className="btn btn-soft" onClick={()=>setPath(null)}>Changer</button></div>
    <Card className="stack"><Badge tone="warning">Vérification manuelle requise</Badge>
      <p className="small muted">Les références et justificatifs sont examinés par une personne chez LeRoutier. Aucun opérateur n’est vérifié automatiquement.</p>
      {/* The operator hosts the file, so they are the only party who can keep
          it private. Saying "lien HTTPS sécurisé" let people believe LeRoutier
          was holding the document; it is not, and it cannot revoke the link. */}
      <p className="small muted"><strong>Vos documents restent chez vous.</strong> Vous fournissez un lien HTTPS vers chaque justificatif : LeRoutier enregistre le lien pour l’examiner, mais n’héberge pas le fichier et ne peut ni en limiter ni en retirer l’accès. Utilisez un lien privé, non indexé, et retirez-le une fois votre dossier validé.</p>
      <p className="small muted">Formats acceptés : PDF ou photo (JPG, PNG, WEBP, HEIC, TIFF).</p></Card>
    {path==='company'?<>
      <Card className="stack"><h3>Identité légale de la société</h3>
        {field('Nom affiché sur LeRoutier',displayName,setDisplayName,{required:true,maxLength:200})}{field('Raison sociale / nom légal',legalName,setLegalName,{required:true,maxLength:200})}
        {field('Téléphone de contact',phone,setPhone,{required:true,placeholder:'+229 ...'})}{field('Pays',country,setCountry,{required:true,maxLength:2})}
        {field('RCCM / référence d’immatriculation',registrationRef,setRegistrationRef,{required:true})}{proof('Justificatif RCCM / immatriculation',registrationDocumentUrl,setRegistrationDocumentUrl)}
        {field('Référence fiscale / IFU',taxReference,setTaxReference,{required:true})}{proof('Justificatif fiscal / IFU',taxDocumentUrl,setTaxDocumentUrl)}
        {field('Adresse officielle',registeredAddress,setRegisteredAddress,{required:true,maxLength:500})}{proof('Justificatif de l’adresse officielle',addressProofUrl,setAddressProofUrl)}
      </Card>
      <Card className="stack"><h3>Responsable légal et autorisation de transport</h3>
        {field('Nom du représentant légal',representativeName,setRepresentativeName,{required:true})}{field('Référence de la pièce du représentant',representativeIdReference,setRepresentativeIdReference,{required:true})}
        {proof('Justificatif d’identité du représentant',representativeIdDocumentUrl,setRepresentativeIdDocumentUrl)}
        {field('Référence de l’autorisation / licence de transport',transportAuthorizationReference,setTransportAuthorizationReference,{required:true})}
        {proof('Justificatif de l’autorisation de transport',transportAuthorizationDocumentUrl,setTransportAuthorizationDocumentUrl)}
        <p className="small muted">Une fois la compagnie vérifiée, elle est responsable de ses chauffeurs et convoyeurs. LeRoutier ne demande pas la pièce d’identité personnelle de chaque chauffeur salarié pour activer la compagnie.</p>
      </Card>
    </>:<>
      <Card className="stack"><h3>Identité du chauffeur</h3>
        {field('Nom complet',displayName,setDisplayName,{required:true,maxLength:200})}{field('Téléphone',phone,setPhone,{required:true,placeholder:'+229 ...'})}{field('Pays',country,setCountry,{required:true,maxLength:2})}
        <label className="field">Type de pièce d’identité<select className="control" value={idDocumentType} onChange={e=>setIdDocumentType(e.target.value)}><option value="national_id">Carte nationale d’identité</option><option value="passport">Passeport</option><option value="residence_permit">Titre de séjour</option><option value="other">Autre document officiel</option></select></label>
        {field('Référence de la pièce d’identité',idDocumentReference,setIdDocumentReference,{required:true})}{proof('Justificatif de la pièce d’identité',idDocumentUrl,setIdDocumentUrl)}
        {field('Référence du permis de conduire',licenseReference,setLicenseReference,{required:true})}{proof('Justificatif du permis de conduire',licenseDocumentUrl,setLicenseDocumentUrl)}
        {field('Autorisation / licence de transport',transportAuthorizationReference,setTransportAuthorizationReference,{required:true})}{proof('Justificatif de l’autorisation de transport',transportAuthorizationDocumentUrl,setTransportAuthorizationDocumentUrl)}
        {proof('Photo récente du chauffeur',driverPhotoUrl,setDriverPhotoUrl)}<p className="small muted">Après validation, cette photo et votre nom seront affichés aux voyageurs pour qu’ils puissent reconnaître leur chauffeur.</p>
      </Card>
      <Card className="stack"><h3>Véhicule et preuves</h3>
        {field('Immatriculation',vehicleRegistration,setVehicleRegistration,{required:true})}{proof('Carte grise / justificatif d’immatriculation',vehicleRegistrationDocumentUrl,setVehicleRegistrationDocumentUrl)}
        {field('Marque',vehicleMake,setVehicleMake,{required:true,placeholder:'Toyota'})}{field('Modèle',vehicleModel,setVehicleModel,{required:true,placeholder:'Hiace'})}{field('Couleur',vehicleColor,setVehicleColor,{required:true})}
        {field('Année',vehicleYear,setVehicleYear,{type:'number',min:1980,max:new Date().getFullYear()+1})}{field('Nombre de places',vehicleCapacity,setVehicleCapacity,{required:true,type:'number',min:1,max:100})}
        {field('Référence assurance',insuranceReference,setInsuranceReference,{required:true})}{proof('Justificatif d’assurance',insuranceDocumentUrl,setInsuranceDocumentUrl)}
        {field('Référence contrôle technique',roadworthinessReference,setRoadworthinessReference,{required:true})}{proof('Justificatif du contrôle technique',roadworthinessDocumentUrl,setRoadworthinessDocumentUrl)}
        {field('Photo du véhicule (facultatif)',vehiclePhotoUrl,setVehiclePhotoUrl,{type:'url',placeholder:'https://…'})}
        <p className="small muted">Après validation, marque, modèle, couleur et immatriculation seront clairement affichés avec l’offre de trajet. Les documents privés ne seront jamais affichés aux voyageurs.</p>
      </Card>
    </>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <button className="btn btn-primary" disabled={!online||busy} type="submit">{busy?'Envoi du dossier…':'Envoyer le dossier pour vérification'}</button>
  </form>;
}
