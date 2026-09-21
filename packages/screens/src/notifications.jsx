import { useState } from 'react';
import { useApi, useSession } from '@leroutier/config/client';
import { Card, Badge, SectionTitle, ApiState, EmptyState } from '@leroutier/ui';
import { Bell, BellOff, ShieldCheck, Bus, Package as PackageIcon, Wallet, TriangleAlert } from 'lucide-react';

// One notification centre for every workspace. Content is role-aware because
// the API only ever returns notifications addressed to the caller's identity —
// the client does no filtering and therefore cannot leak another role's items.
const TEMPLATES = {
  booking_created: 'Réservation enregistrée',
  payment_succeeded: 'Paiement confirmé',
  payment_failed: 'Paiement refusé',
  ticket_ready: 'Billet prêt',
  parcel_created: 'Envoi enregistré',
  parcel_accepted: 'Colis accepté',
  parcel_loaded: 'Colis chargé',
  parcel_in_transit: 'Colis en route',
  parcel_arrived: 'Colis arrivé',
  parcel_ready_for_pickup: 'Colis prêt au retrait',
  parcel_collected: 'Colis retiré',
  parcel_cancelled: 'Envoi annulé',
  parcel_delayed: 'Colis retardé',
  parcel_exception: 'Incident colis',
  booking_cancelled: 'Réservation annulée',
  first_mile_leave_soon: 'Il est temps de partir',
  boarding_starts_soon: 'Embarquement bientôt',
  service_delayed: 'Départ retardé',
  service_cancelled: 'Service annulé',
  service_disrupted: 'Service perturbé',
  boarding_point_changed: 'Point d’embarquement modifié',
  passenger_boarded: 'Embarquement confirmé',
  arrival_completed: 'Voyage terminé',
  driver_new_booking: 'Nouvelle réservation',
  driver_booking_cancelled: 'Réservation annulée',
  settlement_credited: 'Recette créditée',
  payout_paid: 'Retrait payé',
  payout_failed: 'Retrait échoué',
  boarding_point_moderated: 'Point d’embarquement examiné',
  crew_service_rescheduled: 'Service replanifié',
  crew_service_cancelled: 'Service annulé',
  crew_boarding_point_changed: 'Point d’embarquement modifié',
  crew_incident: 'Incident à traiter',
  crew_recovery: 'Instructions de récupération',
  crew_walkup_recorded: 'Vente au comptant enregistrée',
  crew_parcel_to_load: 'Colis à charger',
  crew_parcel_to_unload: 'Colis à décharger',
  crew_parcel_exception: 'Anomalie colis',
  crew_next_station: 'Station suivante',
  ops_service_cancelled: 'Service annulé',
  ops_service_disrupted: 'Service perturbé',
  ops_incident: 'Incident signalé',
  ops_payment_anomaly: 'Anomalie de paiement',
  ops_payout_anomaly: 'Anomalie de retrait',
  ops_payout_failed: 'Retrait échoué',
  ops_parcel_lost: 'Colis perdu',
  ops_parcel_damaged: 'Colis endommagé',
  ops_parcel_exception: 'Anomalie colis',
  ops_point_pending_moderation: 'Point d’embarquement à modérer',
  ops_boarding_point_changed: 'Point d’embarquement modifié',
};
const tone = severity => (severity === 'urgent' ? 'danger' : severity === 'warning' ? 'warning' : 'neutral');
const when = value => new Date(value).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const clock = value => new Date(value).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

// A notification belongs to a subject the user recognises, never to a backend
// event name.
const SUBJECTS = {
  booking: { label: 'Voyage', icon: Bus }, service: { label: 'Voyage', icon: Bus },
  parcel: { label: 'Colis', icon: PackageIcon }, payout: { label: 'Argent', icon: Wallet },
  incident: { label: 'Exploitation', icon: TriangleAlert }, boarding_point: { label: 'Exploitation', icon: TriangleAlert },
  none: { label: 'Information', icon: Bell },
};
const subjectOf = notification => SUBJECTS[notification.entityType] ?? SUBJECTS.none;
const isToday = value => new Date(value).toDateString() === new Date().toDateString();

// Deep-link target for a notification's related entity.
export function notificationTarget(notification) {
  const id = notification.entityId;
  if (!id) return null;
  if (notification.entityType === 'booking') return `/tickets/${id}`;
  if (notification.entityType === 'parcel') return `/parcels/${id}`;
  if (notification.entityType === 'service') return `/work/today`;
  if (notification.entityType === 'payout') return `/work/earnings`;
  if (notification.entityType === 'incident') return `/ops/incidents`;
  if (notification.entityType === 'boarding_point') return `/work/boarding-points`;
  return null;
}

export function NotificationCentre({ onOpen }) {
  const { request, online } = useSession();
  const notifications = useApi('/notifications');
  const [busy, setBusy] = useState('');
  async function open(notification) {
    if (!notification.read) {
      setBusy(notification.id);
      try { await request(`/notifications/${notification.id}/read`, { method: 'POST' }); notifications.reload(); }
      catch { /* reading is not critical; the item stays unread */ }
      finally { setBusy(''); }
    }
    const target = notificationTarget(notification);
    if (target) onOpen?.(target);
  }
  return <div className="stack">
    <SectionTitle icon={Bell} title="Notifications"/>
    {notifications.loading || notifications.error ? <ApiState resource={notifications} empty=""/>
      : !notifications.data?.length
        ? <EmptyState icon={BellOff} title="Aucune notification" text="Vos alertes de voyage, de paiement et de service apparaîtront ici."/>
        : <>{[['Aujourd’hui', notifications.data.filter(n => isToday(n.createdAt))],
          ['Plus tôt', notifications.data.filter(n => !isToday(n.createdAt))]]
          .filter(([, rows]) => rows.length)
          .map(([heading, rows]) => <div className="stack" key={heading}>
            <span className="eyebrow">{heading}</span>
            {rows.map(n => { const subject = subjectOf(n); const Icon = subject.icon; return <button key={n.id} type="button"
              className={`note-row ${n.read ? '' : 'unread'} ${n.severity === 'urgent' ? 'urgent' : ''}`}
              onClick={() => open(n)} disabled={busy === n.id || !online}>
              <Icon size={17}/>
              <div>
                <div className="between wrap">
                  <strong className="small">{TEMPLATES[n.template] ?? subject.label}</strong>
                  {n.severity !== 'info' && <Badge tone={tone(n.severity)}>{n.severity === 'urgent' ? 'à traiter' : 'attention'}</Badge>}
                </div>
                <span className="small muted">{subject.label} · {isToday(n.createdAt) ? clock(n.createdAt) : when(n.createdAt)}</span>
                {n.data?.departureAt && <span className="small muted"> · départ {clock(n.data.departureAt)}</span>}
                {n.data?.boardingPointName && <span className="small muted"> · {n.data.boardingPointName}</span>}
                {n.data?.trackingNumber && <span className="small muted"> · {n.data.trackingNumber}</span>}
                {/* Honest channel state: an unconfigured provider is shown as such. */}
                {n.channels && Object.entries(n.channels).some(([c, s]) => c !== 'in_app' && s === 'unavailable') &&
                  <span className="small muted"> · envoi externe indisponible</span>}
              </div>
            </button>; })}
          </div>)}</>}
    <NotificationPreferences/>
  </div>;
}

export function NotificationPreferences() {
  const { request, online } = useSession();
  const preferences = useApi('/notifications/preferences');
  const [error, setError] = useState(''), [busy, setBusy] = useState('');
  async function toggle(category, channel, enabled) {
    setBusy(category + channel); setError('');
    try { await request('/notifications/preferences', { method: 'PUT', body: { category, channel, enabled } }); preferences.reload(); }
    catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  if (preferences.loading || preferences.error || !preferences.data) return null;
  return <Card className="stack">
    <SectionTitle icon={ShieldCheck} title="Préférences de notification"/>
    {error && <p role="alert" className="small">{error}</p>}
    {preferences.data.categories.map(category => <div key={category.category} className="stack">
      <div className="between wrap">
        <strong className="small">{category.category === 'critical' ? 'Alertes essentielles' : category.category === 'operational' ? 'Opérationnel' : 'Nouveautés & offres'}</strong>
        {category.locked && <Badge tone="neutral">toujours actif</Badge>}
      </div>
      {category.locked
        ? <p className="small muted">Paiement, annulation et changement de point d’embarquement vous sont toujours communiqués.</p>
        : <div className="controls">{category.channels.map(channel => {
          const available = preferences.data.channels.find(c => c.channel === channel.channel)?.available;
          return <button key={channel.channel} className={`control ${channel.enabled ? 'active' : ''}`}
            disabled={!available || !online || busy === category.category + channel.channel}
            onClick={() => toggle(category.category, channel.channel, !channel.enabled)}>
            {channel.channel === 'in_app' ? 'Application' : channel.channel === 'web_push' ? 'Push' : channel.channel === 'sms' ? 'SMS' : channel.channel === 'whatsapp' ? 'WhatsApp' : 'E-mail'}
            {!available && ' (indisponible)'}
          </button>;
        })}</div>}
    </div>)}
    <p className="small muted">Les canaux marqués indisponibles n’ont pas encore de fournisseur configuré : rien n’est envoyé et rien n’est présenté comme envoyé.</p>
  </Card>;
}

// Unread count for the shell badge. Returns 0 while loading or offline.
export function useUnreadCount() {
  const unread = useApi('/notifications?unread=true');
  return unread.data?.length ?? 0;
}
