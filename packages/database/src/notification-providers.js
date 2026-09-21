import { confirmationEmail, parcelMessages } from '@leroutier/notifications/content';
import { bookingDocument } from './booking-document.js';

// Contract for the owner's notification gateway, shared by API and worker.
// It must deduplicate Idempotency-Key and return {accepted:true} only after
// provider acceptance. No provider configuration means no outbound attempt.
export function notificationProviders(db, config, fetcher = fetch) {
  return Object.fromEntries(['email','sms','whatsapp'].flatMap(channel => {
    const provider = config.notificationProviders?.[channel];
    if (provider?.idempotent === true && typeof provider.send === 'function') return [[channel, provider]];
    if (!provider?.url || !provider?.key) return [];
    try { if (new URL(provider.url).protocol !== 'https:') return []; } catch { return []; }
    return [[channel, { idempotent:true, async send({ notification:n, idempotencyKey }) {
      const message = await db.transaction(async tx => {
        const user = n.user_id ? (await tx.query('SELECT u.notification_email,u.active,u.is_demo,p.phone FROM users u LEFT JOIN passenger_profiles p ON p.user_id=u.id WHERE u.id=$1',[n.user_id])).rows[0] : null;
        if (user && (!user.active || user.is_demo)) throw new Error('Recipient unavailable');
        const to = channel === 'email' ? user?.notification_email : n.contact || user?.phone;
        if (!to) return null;
        let content;
        if (channel === 'email' && n.template === 'ticket_ready' && n.entity_type === 'booking') {
          const b = await bookingDocument(tx,n.entity_id);
          if (!b || b.is_demo || b.passenger_id !== n.user_id) throw new Error('Booking unavailable');
          content = confirmationEmail(b);
        } else {
          const number = n.data?.trackingNumber;
          content = {subject:'LeRoutier',text:`LeRoutier · ${parcelMessages[n.template] || 'Une mise à jour est disponible dans votre compte.'}${number ? ` · ${number} · https://leroutier.app/parcels/track?ref=${encodeURIComponent(number)}` : ' https://leroutier.app'}`};
        }
        return {channel,to,...content};
      });
      if (!message) return {accepted:false,unavailable:true};
      const response = await fetcher(provider.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{'content-type':'application/json',authorization:'Bearer '+provider.key,'idempotency-key':idempotencyKey},body:JSON.stringify(message)});
      if (!response.ok || (await response.json())?.accepted !== true) throw new Error('Provider did not accept');
      return {accepted:true};
    } }]];
  }));
}
