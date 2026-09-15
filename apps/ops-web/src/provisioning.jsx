import { useRef, useState } from 'react';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, SectionTitle, ApiState } from '@leroutier/ui';

function Field({label,name,type='text',options=undefined,...props}){
  return <label>{label}{options?<select className="control" name={name} required {...props}><option value="">Sélectionner…</option>{options.map(o=><option key={o.id} value={o.id}>{o.name || o.display_name || o.registration}</option>)}</select>:<input className="control" name={name} type={type} required {...props}/>}</label>;
}
function ProvisionForm({title,path,children,body,onSaved,method='POST'}){
  const {request,online}=useSession(),key=useRef(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(e){
    e.preventDefault();const form=e.currentTarget,payload=body(new FormData(form)),fingerprint=JSON.stringify(payload);
    if(key.current?.fingerprint!==fingerprint)key.current={fingerprint,value:crypto.randomUUID()};
    setBusy(true);setError('');
    try{await request(path,{method,body:payload,key:key.current.value});key.current=null;form.reset();onSaved();}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <details><summary>{title}</summary><form className="stack" onSubmit={submit}><fieldset disabled={busy || !online} className="stack">{children}<button className="btn btn-primary">Enregistrer</button></fieldset>{error && <p role="alert">{error}</p>}</form></details>;
}
export function Provisioning({onSaved=()=>{}}){
  const {user}=useSession(),catalog=useApi(user?'/ops/provisioning':null),[operator,setOperator]=useState(''),[notice,setNotice]=useState(''),[stopCount,setStopCount]=useState(2);
  if(!user)return null;
  const data=catalog.data,operatorId=user.operator_id || operator || data?.operators[0]?.id;
  const saved=()=>{setNotice('Création enregistrée.');catalog.reload();onSaved();};
  const formProps={onSaved:saved};
  const scope=items=>items.filter(x=>x.operator_id===operatorId);
  return <Card className="stack"><SectionTitle title="Administration du réseau"/>
    {notice && <p role="status">{notice}</p>}
    {catalog.loading || catalog.error || !data?<ApiState resource={catalog}/>:<>
      {!user.operator_id && <ProvisionForm title="Créer un opérateur" path="/ops/operators" body={f=>({name:f.get('name'),key:f.get('key')})} {...formProps}><Field label="Nom de l’opérateur" name="name" maxLength={100}/><Field label="Identifiant de l’opérateur" name="key" pattern="[a-z0-9-]+" maxLength={60}/></ProvisionForm>}
      <label>Opérateur<select className="control" value={operatorId || ''} onChange={e=>setOperator(e.target.value)}>{data.operators.map(o=><option value={o.id} key={o.id}>{o.name}</option>)}</select></label>
      {operatorId && <>
        <ProvisionForm title="Provisionner un conducteur" path="/ops/drivers" body={f=>({operatorId,subject:f.get('subject'),displayName:f.get('name'),licenseReference:f.get('license')})} {...formProps}>
          <p className="small muted">Utilisez l’identifiant utilisateur vérifié par votre fournisseur d’identité, jamais un mot de passe.</p><Field label="Identifiant d’identité du conducteur" name="subject" maxLength={255}/><Field label="Nom du conducteur" name="name" maxLength={100}/><Field label="Référence du permis" name="license" maxLength={100}/>
        </ProvisionForm>
        <ProvisionForm title="Provisionner un convoyeur" path="/ops/convoyeurs" body={f=>({operatorId,subject:f.get('subject'),displayName:f.get('name')})} {...formProps}><Field label="Identifiant d’identité du convoyeur" name="subject" maxLength={255}/><Field label="Nom du convoyeur" name="name" maxLength={100}/><p className="small muted">Le convoyeur contrôle les billets, vend au comptant et suit les colis — il ne conduit pas.</p></ProvisionForm>
        <ProvisionForm title="Provisionner un agent Ops" path="/ops/ops-users" body={f=>({operatorId,subject:f.get('subject'),displayName:f.get('name')})} {...formProps}><Field label="Identifiant d’identité de l’agent" name="subject" maxLength={255}/><Field label="Nom de l’agent" name="name" maxLength={100}/><p className="small muted">L’agent pourra administrer uniquement cet opérateur.</p></ProvisionForm>
        <details><summary>Comptes de l’opérateur</summary><div className="stack">{scope(data.users).map(u=><div key={u.id}><p>{u.display_name} · {u.role} · {u.active && u.driver_active!==false?'Actif':'Inactif'}</p>{u.id!==user.id && <ProvisionForm title={u.active?'Désactiver le compte':'Activer le compte'} path={`/ops/users/${u.id}/status`} method="PATCH" body={()=>({active:!u.active})} {...formProps}><p>Confirmer le changement pour {u.display_name}.</p></ProvisionForm>}</div>)}</div></details>
        <ProvisionForm title="Ajouter un véhicule" path="/ops/vehicles" body={f=>({operatorId,registration:f.get('registration'),capacity:Number(f.get('capacity'))})} {...formProps}><Field label="Immatriculation" name="registration" maxLength={40}/><Field label="Nombre de places" name="capacity" type="number" min={1} max={100}/></ProvisionForm>
      </>}
      <ProvisionForm title="Ajouter une localité" path="/ops/places" body={f=>({name:f.get('name'),kind:'city'})} {...formProps}><Field label="Nom de la localité" name="name" maxLength={100}/></ProvisionForm>
      <ProvisionForm title="Ajouter un arrêt" path="/ops/stops" body={f=>({name:f.get('name'),placeId:f.get('place'),latitude:Number(f.get('latitude')),longitude:Number(f.get('longitude'))})} {...formProps}><Field label="Localité" name="place" options={data.places}/><Field label="Nom de l’arrêt" name="name" maxLength={100}/><Field label="Latitude" name="latitude" type="number" step="any" min={-90} max={90}/><Field label="Longitude" name="longitude" type="number" step="any" min={-180} max={180}/></ProvisionForm>
      {operatorId && <>
        <ProvisionForm title="Créer une ligne et ses tarifs" path="/ops/routes" body={f=>({operatorId,name:f.get('name'),stops:f.getAll('stop').map((stopId,i)=>({stopId,fareToNext:i===stopCount-1?0:Number(f.getAll('fare')[i])}))})} {...formProps}>
          <Field label="Nom de la ligne" name="name" maxLength={200}/><p className="small muted">Ajoutez les arrêts dans l’ordre du voyage. Le tarif de chaque tronçon est exprimé en FCFA.</p>
          {Array.from({length:stopCount},(_,i)=><div className="stack" key={i}><Field label={`Arrêt ${i+1}`} name="stop" options={data.stops}/>{i<stopCount-1 && <Field label={`Tarif de l’arrêt ${i+1} au suivant`} name="fare" type="number" min={0} max={1000000}/>}</div>)}
          <div className="controls"><button type="button" className="btn btn-soft" disabled={stopCount>=100} onClick={()=>setStopCount(n=>n+1)}>Ajouter un arrêt à la ligne</button><button type="button" className="btn btn-soft" disabled={stopCount<=2} onClick={()=>setStopCount(n=>n-1)}>Retirer le dernier arrêt</button></div>
        </ProvisionForm>
        <ProvisionForm title="Planifier un départ" path="/ops/services" body={f=>({routeId:f.get('route'),vehicleId:f.get('vehicle'),driverId:f.get('driver'),departureAt:new Date(String(f.get('departure'))).toISOString()})} {...formProps}>
          <Field label="Ligne" name="route" options={scope(data.routes)}/><Field label="Véhicule" name="vehicle" options={scope(data.vehicles).filter(v=>v.status==='active')}/><Field label="Conducteur" name="driver" options={scope(data.users).filter(u=>u.role==='driver' && u.active && u.driver_active)}/><Field label="Date et heure de départ (heure locale)" name="departure" type="datetime-local"/><p className="small muted">Le service et son affectation seront créés ensemble. Le véhicule et le conducteur doivent être libres.</p>
        </ProvisionForm>
      </>}
    </>}
  </Card>;
}
