import { useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { authClient } from '../lib/api';
import type { User } from '../lib/api';
import { Brand, Icon } from './Brand';
import './AppShell.css';

export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');
  const name = user.displayName || user.email.split('@')[0];
  const initials = name.trim().split(/\s+/).slice(-2).map((part) => part[0]).join('').toLocaleUpperCase('vi');

  async function logout() {
    setError(''); setLoggingOut(true);
    try { await authClient.logout(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Chưa thể đăng xuất. Vui lòng thử lại.'); }
    finally { setLoggingOut(false); }
  }

  return <div className="account-shell">
    <header className="account-header">
      <div className="header-left"><Brand />
        <nav className="app-nav" aria-label="Chính">
          <NavLink to="/" end><Icon name="folder" size={17} />Tài liệu</NavLink>
          <NavLink to="/trash"><Icon name="trash" size={17} />Thùng rác</NavLink>
          <NavLink to="/account"><Icon name="user" size={17} />Tài khoản</NavLink>
        </nav>
      </div>
      <div className="header-right"><span className="personal-tag"><span /> Không gian cá nhân</span>
        <details className="account-menu"><summary aria-label={`Tài khoản ${name}`}><span className="avatar">{initials}</span><span className="menu-name">{name}</span><Icon name="chevron" size={16} /></summary>
          <div className="account-dropdown"><p>Đang đăng nhập bằng</p><strong>{user.email}</strong><button onClick={logout} disabled={loggingOut}><Icon name="logout" size={17} />{loggingOut ? 'Đang đăng xuất…' : 'Đăng xuất'}</button></div>
        </details>
      </div>
    </header>
    <main className="account-main">
      {error && <div className="form-alert account-alert" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div>}
      {children}
      <div className="account-signout"><span>Đã xong việc hôm nay?</span><button type="button" onClick={logout} disabled={loggingOut}>{loggingOut ? 'Đang đăng xuất…' : 'Đăng xuất an toàn'}<Icon name="logout" size={16} /></button></div>
    </main>
    <footer className="account-footer"><span>© 2026 DocFlow</span><span>Tài liệu gọn. Cuộc sống nhẹ.</span></footer>
  </div>;
}
