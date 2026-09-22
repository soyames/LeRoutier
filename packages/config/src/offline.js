// Deliberately stores no auth tokens or passenger profile fields.
export const OFFLINE_TTL=12*3600_000;
export function validateQueuedAction(type,payload){
  const fields=type==='incident'?['serviceId','kind','severity','description']:type==='parcel'?['serviceId','parcelId','kind']:['serviceId','bookingId','stopSequence','code'];
  if(!['board','alight','incident','parcel'].includes(type) || !payload || Object.keys(payload).some(k=>!fields.includes(k)) || typeof payload.serviceId!=='string')throw new Error('Action hors ligne invalide.');
  if(type==='board' || type==='alight'){if(!Number.isInteger(payload.stopSequence) || !(typeof payload.bookingId==='string' || typeof payload.code==='string'))throw new Error('Billet et arrêt requis.');}
  if(type==='incident' && (typeof payload.description!=='string' || payload.description.length>2000 || !payload.description.trim()))throw new Error('Description requise.');
  if(type==='parcel' && (typeof payload.parcelId!=='string' || !['loaded','departed','arrived'].includes(payload.kind)))throw new Error('Scan colis invalide.');
}
export const QUEUE_PREFIX='lr-driver-queue:';
/**
 * Drop every queued crew action left in this browser.
 *
 * A pending board/alight row carries the passenger's ticket code. The queue is
 * keyed per user, so the next person to sign in on a shared station handset
 * cannot read it through the app — but it outlived sign-out in localStorage,
 * which is not where somebody else's ticket code belongs. Signing out clears
 * the device, not merely the session.
 */
export function clearQueuedActions(storage){
  try{
    const stale=[];
    for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key?.startsWith(QUEUE_PREFIX))stale.push(key);}
    for(const key of stale)storage.removeItem(key);
    return stale.length;
  }catch{return 0;}
}
export function createSyncQueue(storage,owner,now=()=>Date.now()){
  const name=QUEUE_PREFIX+owner;
  let running=null;
  function read(){try{const rows=JSON.parse(storage.getItem(name)||'[]');return Array.isArray(rows)?rows.filter(r=>r.owner===owner && now()-r.createdAt<OFFLINE_TTL):[];}catch{return [];}}
  const write=rows=>storage.setItem(name,JSON.stringify(rows));
  function update(id,patch){write(read().map(r=>r.id===id?{...r,...patch}:r));}
  return {
    read,
    enqueue(type,payload){validateQueuedAction(type,payload);const rows=read();if(rows.filter(r=>r.state!=='succeeded').length>=100)throw new Error('Synchronisez les actions en attente avant de continuer.');
      const existing=rows.find(r=>r.type===type && JSON.stringify(r.payload)===JSON.stringify(payload) && ['pending','syncing'].includes(r.state));if(existing)return existing;
      const row={id:crypto.randomUUID(),owner,type,payload,createdAt:now(),state:'pending',attempts:0,error:null};write([...rows,row]);return row;},
    retry(id){const row=read().find(r=>r.id===id);if(row && row.state==='failed')update(id,{state:'pending',attempts:0,error:null});},
    discard(id){write(read().filter(r=>r.id!==id));},
    clear(){storage.removeItem(name);},
    sync(send){
      if(running)return running;
      running=(async()=>{
        for(const row of read()){
          if(!['pending','syncing'].includes(row.state) || row.attempts>=3)continue;
          try{
            validateQueuedAction(row.type,row.payload);update(row.id,{state:'syncing',attempts:row.attempts+1});
            await send(row);update(row.id,{state:'succeeded',error:null,payload:{serviceId:row.payload.serviceId}});
          }catch(error){
            const terminal=[400,403,404,409,422].includes(error.status),needsLogin=error.status===401;
            update(row.id,{state:terminal?'conflict':needsLogin?'pending':row.attempts+1>=3?'failed':'pending',error:needsLogin?'Reconnectez-vous pour synchroniser.':terminal?'Action refusée par le serveur. Vérifiez le manifeste.':'Échec réseau. Action toujours en attente.'});
            if(!terminal)break;
          }
        }
        return read();
      })().finally(()=>{running=null;});return running;
    },
  };
}
