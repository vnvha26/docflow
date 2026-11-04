import { useEffect, useState } from 'react';
import { Brand, DocumentArt, Icon } from '../../components/Brand';
import { authClient } from '../../lib/api';
import type { User } from '../../lib/api';
import { PasswordSettings } from './PasswordSettings';
import { ProfileSettings } from './ProfileSettings';
import { SessionPanel } from './SessionPanel';
import './account.css';

export function AccountPage({ user }: { user: User }) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const name = user.displayName || user.email.split('@')[0];
  const initials = name.trim().split(/\s+/).slice(-2).map((part) => part[0]).join('').toLocaleUpperCase('vi');
  useEffect(() => { document.title = 'Tài khoản của bạn | DocFlow'; }, []);

  async function logout() {
    setError(''); setLoggingOut(true);
    try { await authClient.logout(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Chưa thể đăng xuất. Vui lòng thử lại.'); }
    finally { setLoggingOut(false); }
  }

  return <div className="account-shell">
    <header className="account-header"><Brand /><div className="header-right"><span className="personal-tag"><span /> Không gian cá nhân</span><details className="account-menu"><summary aria-label={`Tài khoản ${name}`}><span className="avatar">{initials}</span><span className="menu-name">{name}</span><Icon name="chevron" size={16} /></summary><div className="account-dropdown"><p>Đang đăng nhập bằng</p><strong>{user.email}</strong><button onClick={logout} disabled={loggingOut}><Icon name="logout" size={17} />{loggingOut ? 'Đang đăng xuất…' : 'Đăng xuất'}</button></div></details></div></header>
    <main className="account-main">
      <section className="welcome-card"><div><span className="eyebrow"><span /> CHÀO MỪNG VỀ NHÀ</span><h1>Chào {name}<span>.</span></h1><p>Mọi khởi đầu gọn gàng đều từ một không gian riêng.<br />Tài khoản DocFlow của bạn đã sẵn sàng.</p><span className="welcome-status"><span><Icon name="check" size={13} /></span> Bạn đã đăng nhập thành công</span></div><DocumentArt compact /></section>
      {error && <div className="form-alert account-alert" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div>}
      <ProfileSettings key={user.id} user={user} />
      <PasswordSettings onChanged={() => setSessionsVersion((version) => version + 1)} />
      <SessionPanel key={`${user.id}:${sessionsVersion}`} />
      <div className="account-signout"><span>Đã xong việc hôm nay?</span><button type="button" onClick={logout} disabled={loggingOut}>{loggingOut ? 'Đang đăng xuất…' : 'Đăng xuất an toàn'}<Icon name="logout" size={16} /></button></div>
    </main>
    <footer className="account-footer"><span>© 2026 DocFlow</span><span>Tài liệu gọn. Cuộc sống nhẹ.</span></footer>
  </div>;
}
