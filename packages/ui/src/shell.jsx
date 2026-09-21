import { Bell, Wifi, WifiOff } from 'lucide-react';
import { Logo } from './logo.jsx';

/**
 * @typedef {import('react').ReactNode} ReactNode
 * @typedef {import('lucide-react').LucideIcon} Icon
 * @param {{ role: string, title: string, subtitle?: string, nav?: { id: string, label: string, icon: Icon }[], active?: string, onNavigate?: (id: string) => void, children: ReactNode, online?: boolean, actions?: ReactNode, avatar?: ReactNode, onNotifications?: () => void, unread?: number, onHome?: () => void }} props
 */
export function AppShell({ role, title, subtitle, nav = [], active, onNavigate, children, online = true, actions, avatar = null, onNotifications, unread = 0, onHome }) {
  const roleKey = String(role || 'public').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-');
  const pageKey = String(active || title || 'home').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-');
  return <div className="lr-app" data-role={roleKey} data-page={pageKey}>
    <a className="skip-link" href="#lr-content">Aller au contenu</a>
    <header className="lr-header">
      <div className="lr-header-main">
        <div className="lr-brand-wrap">
          {onHome
            ? <button className="lr-brand-btn" onClick={onHome} aria-label="Accueil LeRoutier"><Logo className="lr-logo"/></button>
            : <Logo className="lr-logo"/>}
          <div className="lr-page-title"><strong>{title}</strong><span>{subtitle || role}</span></div>
        </div>
        <div className="lr-header-actions"><Badge tone={online ? 'success' : 'neutral'}>{online ? <Wifi size={14}/> : <WifiOff size={14}/>} {online ? 'En ligne' : 'Hors-ligne'}</Badge>{actions}
          <button className="icon-btn" aria-label={unread > 0 ? `Notifications (${unread} non lues)` : 'Notifications'} onClick={onNotifications} disabled={!onNotifications}>
            <Bell size={19}/>{unread > 0 && <span className="icon-badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
          </button>{avatar}</div>
      </div>
      <div className="lr-role-strip"><span>{role}</span><small>{title} · LeRoutier Bénin</small></div>
    </header>
    <main className="lr-main" id="lr-content">{children}</main>
    {nav.length > 0 && <nav className="lr-bottom-nav" aria-label={`Navigation ${role}`}>{nav.map(item => { const Icon = item.icon; const selected = active === item.id; return <button key={item.id} className={selected ? 'active' : ''} onClick={() => onNavigate?.(item.id)} aria-current={selected ? 'page' : undefined}><Icon size={22}/><span>{item.label}</span></button>; })}</nav>}
  </div>;
}

/** @param {{ children: ReactNode, className?: string, tone?: string }} props */
export function Card({ children, className = '', tone = 'default' }) { return <section className={`card card-${tone} ${className}`}>{children}</section>; }
/** @param {{ children: ReactNode, tone?: string }} props */
export function Badge({ children, tone = 'neutral' }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
/** @param {{ label: string, value: ReactNode, hint?: string, icon?: Icon, tone?: string }} props */
export function StatCard({ label, value, hint, icon: Icon, tone = 'default' }) { return <Card className="stat-card"><div className={`stat-icon stat-${tone}`}>{Icon && <Icon size={18}/>}</div><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</Card>; }
/** @param {{ icon?: Icon, title: string, trailing?: ReactNode }} props */
export function SectionTitle({ icon: Icon, title, trailing }) { return <div className="section-title"><div>{Icon && <Icon size={20}/>}<h2>{title}</h2></div>{trailing}</div>; }
/** @param {{ icon?: Icon, title: string, text: string, action?: ReactNode }} props */
export function EmptyState({ icon: Icon, title, text, action }) { return <Card className="empty"><div className="empty-icon">{Icon && <Icon size={26}/>}</div><strong>{title}</strong><p>{text}</p>{action}</Card>; }
