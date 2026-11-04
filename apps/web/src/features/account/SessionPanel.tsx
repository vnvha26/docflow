import { useEffect, useState } from 'react';
import { authClient, StaleSessionError } from '../../lib/api';
import { Icon } from '../../components/Brand';

interface LoginSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  isCurrent: boolean;
}

const sessionDate = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

function browserName(userAgent: string | null): string {
  const agent = userAgent ?? '';
  if (/Edg(?:e|A|iOS)?\//.test(agent)) return 'Microsoft Edge';
  if (/OPR\//.test(agent)) return 'Opera';
  if (/SamsungBrowser\//.test(agent)) return 'Samsung Internet';
  if (/(?:Firefox|FxiOS)\//.test(agent)) return 'Firefox';
  if (/(?:Chrome|CriOS)\//.test(agent)) return 'Chrome';
  if (/Safari\//.test(agent)) return 'Safari';
  return 'Trình duyệt chưa xác định';
}

export function SessionPanel() {
  const [sessions, setSessions] = useState<LoginSession[]>([]);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    authClient.request<LoginSession[]>('/auth/sessions').then((result) => {
      if (active) setSessions(result);
    }).catch((failure: unknown) => {
      if (active && !(failure instanceof StaleSessionError)) {
        setError(failure instanceof Error ? failure.message : 'Chưa thể tải danh sách phiên.');
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [reload]);

  function refreshList() {
    setLoading(true);
    setError('');
    setMessage('');
    setReload((previous) => previous + 1);
  }

  async function revoke(sessionId: string) {
    setRevoking(sessionId);
    setError('');
    setMessage('');
    try {
      await authClient.request<void>(`/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: 'POST' });
      setSessions((previous) => previous.filter((session) => session.id !== sessionId));
      setMessage('Đã đăng xuất phiên được chọn.');
    } catch (failure) {
      if (!(failure instanceof StaleSessionError)) {
        setError(failure instanceof Error ? failure.message : 'Chưa thể đăng xuất phiên.');
      }
    } finally {
      setRevoking(null);
    }
  }

  return (
    <section className="profile-card session-card" aria-labelledby="session-title">
      <div className="profile-heading">
        <div>
          <span className="auth-kicker">BẢO MẬT TÀI KHOẢN</span>
          <h2 id="session-title">Phiên đăng nhập</h2>
        </div>
        <span className="profile-icon"><Icon name="shield" size={24} /></span>
      </div>
      <p className="session-note">Xem các phiên đang hoạt động và đăng xuất khỏi trình duyệt khác.</p>
      {error && <div className="form-alert" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div>}
      <div className="session-list" aria-busy={loading}>
        {sessions.length > 0 && <ul>
          {sessions.map((session) => (
            <li key={session.id}>
              <div className="session-info">
                <div className="session-label">
                  <strong>{browserName(session.userAgent)}</strong>
                  {session.isCurrent && <span className="session-current">Phiên hiện tại</span>}
                </div>
                <p>Đăng nhập lúc <time dateTime={session.createdAt}>{sessionDate.format(new Date(session.createdAt))}</time></p>
                <p>Hết hạn lúc <time dateTime={session.expiresAt}>{sessionDate.format(new Date(session.expiresAt))}</time></p>
              </div>
              {!session.isCurrent && (
                <button type="button" className="button-secondary" disabled={loading || revoking !== null} onClick={() => revoke(session.id)}>
                  {revoking === session.id ? 'Đang đăng xuất…' : 'Đăng xuất phiên'}
                </button>
              )}
            </li>
          ))}
        </ul>}
        {!loading && !error && sessions.length === 0 && <p className="session-note">Không có phiên đang hoạt động.</p>}
      </div>
      <div className="profile-bottom">
        <p role="status">{loading ? 'Đang tải danh sách phiên…' : message}</p>
        <button type="button" className="button-secondary" onClick={refreshList} disabled={loading || revoking !== null}>
          Làm mới danh sách
        </button>
      </div>
    </section>
  );
}
