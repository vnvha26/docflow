import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AppShell } from '../../components/AppShell';
import type { User } from '../../lib/api';
import { PasswordSettings } from './PasswordSettings';
import { PrivacySettings } from './PrivacySettings';
import { ProfileSettings } from './ProfileSettings';
import { SessionPanel } from './SessionPanel';
import './account.css';

export function AccountPage({ user }: { user: User }) {
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const location = useLocation();
  useEffect(() => { document.title = 'Tài khoản của bạn | DocFlow'; }, []);
  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [location.hash]);

  return <AppShell user={user}>
    <div className="page-heading"><span className="eyebrow"><span /> CÀI ĐẶT</span><h1>Tài khoản<span>.</span></h1></div>
    <ProfileSettings key={user.id} user={user} />
    <PrivacySettings key={user.id} user={user} />
    <PasswordSettings onChanged={() => setSessionsVersion((version) => version + 1)} />
    <SessionPanel key={`${user.id}:${sessionsVersion}`} />
  </AppShell>;
}
