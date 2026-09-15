import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError, invariant } from '@leroutier/domain';

// FedaPay adapter (official contract, docs.fedapay.com, checked 2026-09):
//  - live base    https://api.fedapay.com/v1        sandbox https://sandbox-api.fedapay.com/v1
//  - auth         Authorization: Bearer <secret key>
//  - collections  POST /transactions, POST /transactions/{id}/token -> {token,url}
//  - payouts      POST /payouts, PUT /payouts/start [{id}], GET /payouts/{id}
//  - webhooks     header X-FEDAPAY-SIGNATURE = "t=<unix-seconds>,s=<hex hmac-sha256(secret, `${t}.${rawBody}`)>"
//                 (official Node SDK Webhook.constructEvent; 300s tolerance, constant-time compare)
// This file never touches a browser bundle and never exposes secrets.
const LIVE='https://api.fedapay.com/v1',SANDBOX='https://sandbox-api.fedapay.com/v1';
const TOLERANCE=300;

// Explicit allowlist of FedaPay event names LeRoutier reacts to. The account
// webhook also delivers customer/account/payment_request events: those are
// safely ignored unless they correlate to a known LeRoutier record.
const COLLECTION_EVENTS=new Set(['transaction.created','transaction.approved','transaction.declined',
  'transaction.canceled','transaction.transferred','transaction.updated']);
const COLLECTION_STATUS={pending:'pending',approved:'succeeded',transferred:'succeeded',
  declined:'failed',canceled:'cancelled',refunded:'refunded'};
const PAYOUT_STATUS={pending:'processing',scheduled:'processing',started:'processing',
  processing:'processing',sent:'paid',failed:'failed',canceled:'cancelled',reversed:'reversed'};

function hex(secret,raw,timestamp){
  const expected=createHmac('sha256',secret).update(`${timestamp}.${raw}`,'utf8').digest();
  return value=>value && value.length===expected.length*2 && timingSafeEqual(Buffer.from(value,'hex'),expected);
}
export function verifyFedaPaySignature(raw,header,secret,now=Date.now()){
  invariant(typeof secret==='string' && secret.length>=16,'INVALID_WEBHOOK','Webhook verification is not configured.',503);
  invariant(typeof header==='string','INVALID_WEBHOOK','Webhook signature is missing.',401);
  let timestamp=-1;const signatures=[];
  for(const item of header.split(',')){
    const [key,...rest]=item.split('=');const value=rest.join('=');
    if(key==='t'){const parsed=Number.parseInt(value,10);if(Number.isFinite(parsed))timestamp=parsed;}
    else if(key==='s' && /^[0-9a-f]{64}$/i.test(value || ''))signatures.push(value);
  }
  invariant(timestamp>=0 && signatures.length,'INVALID_WEBHOOK','Webhook signature is invalid.',401);
  const age=Math.floor(now/1000)-timestamp;
  invariant(age<=TOLERANCE,'INVALID_WEBHOOK','Webhook signature is too old.',401);
  const matches=hex(secret,raw,timestamp);
  invariant(signatures.some(matches),'INVALID_WEBHOOK','Webhook signature is invalid.',401);
  return true;
}

export function fedapayAdapter(config,http=fetch){
  const {paymentProvider,fedapay:fedapayConfig}=config;
  const environment=fedapayConfig?.environment;
  // Trim terminal-pasted credentials defensively (PowerShell stdin is known to
  // leak \r into values on this machine); keys never contain edge whitespace.
  const secretKey=typeof fedapayConfig?.secretKey==='string'?fedapayConfig.secretKey.trim():undefined;
  const payoutKey=typeof fedapayConfig?.payoutSecretKey==='string'?fedapayConfig.payoutSecretKey.trim():undefined;
  const webhookSecret=typeof fedapayConfig?.webhookSecret==='string'?fedapayConfig.webhookSecret.trim():undefined;
  if(paymentProvider!=='fedapay')return null;
  // Fail closed: production must be explicitly configured as live.
  if(environment!=='sandbox' && environment!=='live')return null;
  if(config.production && environment!=='live')return null;
  if(!secretKey || !webhookSecret)return null;
  const base=(environment==='live'?LIVE:SANDBOX);
  async function send(path,method='GET',body=undefined,token=secretKey){
    let response;
    try{
      response=await http(base+path,{method,redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    }catch{throw new DomainError('PAYMENT_UNAVAILABLE','Le prestataire de paiement est indisponible. Vérifiez le statut avant de réessayer.',503);}
    if(!response.ok){
      if(response.status===422||response.status===400)throw new DomainError('PAYMENT_UNAVAILABLE','Le prestataire a refusé la demande de paiement.',503);
      throw new DomainError('PAYMENT_UNAVAILABLE','Le prestataire de paiement est indisponible. Vérifiez le statut avant de réessayer.',503);
    }
    try{return await response.json();}catch{throw new DomainError('PAYMENT_UNAVAILABLE','La réponse du prestataire est illisible. Réconciliez avant de réessayer.',503);}
  }
  async function fetchEntity(kind,objectId){
    if(!Number.isInteger(objectId))return null;
    try{return await send((kind==='payout'?'/payouts/':'/transactions/')+objectId);}
    catch{return null;}
  }
  function mapEvent(event){
    const name=event.name || event.type;
    if(typeof name!=='string')return null;
    if(COLLECTION_EVENTS.has(name))return mapCollection(event,name);
    if(name.startsWith('payout.'))return mapPayout(event,name);
    return null; // customer.*, account.*, payment_request.*: safely ignored
  }
  function mapCollection(event,name){
    const entity=event.entity || event.data;
    if(!entity)return null;
    const meta=entity.custom_metadata && typeof entity.custom_metadata==='object'?entity.custom_metadata:{};
    const paymentId=meta.payment_id;
    // Isolation: transactions created by other products on this FedaPay account
    // carry no LeRoutier marker and are never processed.
    if(meta.app!=='leroutier' || typeof paymentId!=='string' || !paymentId)return null;
    const status=COLLECTION_STATUS[entity.status];
    const currency=entity.currency?.iso ?? entity.currency;
    if(!status || !Number.isInteger(entity.amount) || typeof currency!=='string' || !currency)return null;
    const reference=entity.reference || String(entity.id);
    if(typeof reference!=='string' || !reference || reference.length>150)return null;
    return {kind:'payment',eventName:name,eventId:String(event.id ?? `${name}:${entity.id}`),
      paymentId,reference,amountMinor:entity.amount,currency,status};
  }
  function mapPayout(event,name){
    const entity=event.entity || event.data;
    if(!entity)return null;
    const meta=entity.custom_metadata && typeof entity.custom_metadata==='object'?entity.custom_metadata:{};
    const status=PAYOUT_STATUS[entity.status];
    if(meta.app!=='leroutier' || typeof meta.payout_request_id!=='string' || !meta.payout_request_id || !status)return null;
    const reference=entity.reference || String(entity.id);
    if(typeof reference!=='string' || !reference || reference.length>150)return null;
    const currency=entity.currency?.iso ?? entity.currency;
    const amountMinor=Number.isInteger(entity.amount)?entity.amount:undefined;
    return {kind:'payout',eventName:name,eventId:String(event.id ?? `${name}:${entity.id}`),
      payoutRequestId:meta.payout_request_id,reference,
      ...(amountMinor!==undefined?{amountMinor}:{}),...(typeof currency==='string'?{currency}:{}),status};
  }
  return {name:'fedapay',environment,
    payoutsAvailable:!!payoutKey,
    // ---- collections ----
    async initiate({paymentId,bookingId,amountMinor,currency,idempotencyKey}){
      const transaction=await send('/transactions','POST',{description:'Réservation LeRoutier',
        amount:amountMinor,currency:{iso:currency},
        custom_metadata:{app:'leroutier',payment_id:paymentId,booking_id:bookingId,idempotency_key:idempotencyKey}});
      invariant(transaction && Number.isInteger(transaction.id),'PAYMENT_UNAVAILABLE','Le prestataire n’a pas confirmé la transaction.',503);
      const link=await send('/transactions/'+transaction.id+'/token','POST',{});
      invariant(link && typeof link.token==='string' && typeof link.url==='string','PAYMENT_UNAVAILABLE','Le lien de paiement est indisponible.',503);
      return {reference:String(transaction.reference ?? transaction.id),
        checkoutUrl:link.url,metadata:{fedapayId:transaction.id,checkoutToken:link.token}};
    },
    async reconcilePayment(payment){
      const id=payment.provider_metadata?.fedapayId;
      if(!Number.isInteger(id))return null;
      const entity=await fetchEntity('payment',id);
      if(!entity)return null;
      const status=COLLECTION_STATUS[entity.status];
      const currency=entity.currency?.iso ?? entity.currency;
      if(!status || !Number.isInteger(entity.amount) || typeof currency!=='string')return null;
      return {kind:'payment',eventId:`reconcile:${id}:${entity.updated_at ?? ''}`,
        paymentId:payment.id,reference:String(entity.reference ?? entity.id),amountMinor:entity.amount,currency,status};
    },
    // ---- payouts ----
    async createPayout({payoutRequestId,firstName,lastName,phoneNumber,country,amountMinor,currency,idempotencyKey}){
      invariant(payoutKey,'PAYOUT_UNAVAILABLE','Le versement des gains n’est pas encore configuré.',503);
      let created;
      try{created=await send('/payouts','POST',{amount:amountMinor,currency:{iso:currency},
        customer:{firstname:firstName,lastname:lastName,phone_number:{number:phoneNumber,country}},
        mode:'mobile_money',
        custom_metadata:{app:'leroutier',payout_request_id:payoutRequestId,idempotency_key:idempotencyKey}},payoutKey);}
      catch{
        throw new DomainError('PAYOUT_UNAVAILABLE','Le versement a été refusé par le prestataire. Vérifiez que FedaPay Payouts est activé pour ce compte.',503);
      }
      invariant(created && Number.isInteger(created.id),'PAYOUT_UNAVAILABLE','Le prestataire n’a pas confirmé le versement.',503);
      let started;
      try{started=await send('/payouts/start','PUT',[{id:created.id}],payoutKey);}
      catch{ /* The payout exists; reconciliation will surface its true state. */ }
      const entity=Array.isArray(started)?started.find(p=>p.id===created.id):started;
      return {reference:String(created.reference ?? created.id),
        metadata:{fedapayId:created.id,providerStatus:entity?.status ?? created.status ?? 'pending'}};
    },
    async reconcilePayout(request){
      const id=request.provider_metadata?.fedapayId;
      if(!Number.isInteger(id))return null;
      const entity=await fetchEntity('payout',id);
      if(!entity)return null;
      const status=PAYOUT_STATUS[entity.status];
      if(!status)return null;
      const currency=entity.currency?.iso ?? entity.currency;
      const amountMinor=Number.isInteger(entity.amount)?entity.amount:undefined;
      return {kind:'payout',eventId:`reconcile:${id}:${entity.updated_at ?? ''}`,
        payoutRequestId:request.id,reference:String(entity.reference ?? entity.id),
        ...(amountMinor!==undefined?{amountMinor}:{}),...(typeof currency==='string'?{currency}:{}),status};
    },
    // ---- webhooks ----
    async verifyEvent(raw,headers){
      invariant(headers,'INVALID_WEBHOOK','Webhook headers are required.',401);
      verifyFedaPaySignature(raw,headers.get('x-fedapay-signature'),webhookSecret);
      let event;
      try{event=JSON.parse(raw);}catch{throw new DomainError('INVALID_WEBHOOK','Webhook body is invalid.',401);}
      invariant(event && typeof event==='object' && !Array.isArray(event),'INVALID_WEBHOOK','Webhook body is invalid.',401);
      const mapped=mapEvent(event);
      if(mapped)return mapped;
      // Authoritative fallback: correlate by provider object id even without entity payload.
      const name=event.name || event.type;
      const kind=COLLECTION_EVENTS.has(name)?'payment':name?.startsWith('payout.')?'payout':null;
      if(!kind || !Number.isInteger(event.object_id))return null;
      const entity=await fetchEntity(kind,event.object_id);
      if(!entity)return null;
      const full={...event,entity};
      return COLLECTION_EVENTS.has(full.name||full.type)?mapCollection(full,full.name||full.type):mapPayout(full,full.name||full.type);
    },
  };
}
