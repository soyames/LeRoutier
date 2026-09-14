import React from 'react';
import { Bell, Wifi, WifiOff } from 'lucide-react';
import { Logo } from './logo.jsx';

export function AppShell({ role, title, subtitle, nav = [], active, onNavigate, children, online = true, actions }) {
  return <div className="lr-app">
    <header className="lr-header">
      <div className="lr-header-main">
        <div className="lr-brand-wrap"><Logo className="lr-logo"/><div className="lr-page-title"><strong>{title}</strong><span>{subtitle || role}</span></div></div>
        <div className="lr-header-actions"><Badge tone={online ? 'success' : 'neutral'}>{online ? <Wifi size={14}/> : <WifiOff size={14}/>} {online ? 'En ligne' : 'Hors-ligne'}</Badge>{actions}<button className="icon-btn" aria-label="Notifications"><Bell size={19}/></button><div className="avatar">LR</div></div>
      </div>
      <div className="lr-role-strip"><span>{role}</span><small>LeRoutier · mobilité interurbaine</small></div>
    </header>
    <main className="lr-main">{children}</main>
    {nav.length > 0 && <nav className="lr-bottom-nav">{nav.map(item => { const Icon = item.icon; const selected = active === item.id; return <button key={item.id} className={selected ? 'active' : ''} onClick={() => onNavigate?.(item.id)} aria-current={selected ? 'page' : undefined}><Icon size={22}/><span>{item.label}</span></button>; })}</nav>}
  </div>;
}

export function Card({ children, className = '', tone = 'default' }) { return <section className={`card card-${tone} ${className}`}>{children}</section>; }
export function Badge({ children, tone = 'neutral' }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
export function StatCard({ label, value, hint, icon: Icon, tone = 'default' }) { return <Card className="stat-card"><div className={`stat-icon stat-${tone}`}>{Icon && <Icon size={18}/>}</div><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</Card>; }
export function SectionTitle({ icon: Icon, title, trailing }) { return <div className="section-title"><div>{Icon && <Icon size={20}/>}<h2>{title}</h2></div>{trailing}</div>; }
export function EmptyState({ icon: Icon, title, text, action }) { return <Card className="empty"><div className="empty-icon">{Icon && <Icon size={26}/>}</div><strong>{title}</strong><p>{text}</p>{action}</Card>; }
