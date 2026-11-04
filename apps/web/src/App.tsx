import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Brand } from './components/Brand';
import { AccountPage } from './features/account/AccountPage';
import { AuthPage } from './features/auth/AuthPage';
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage';
import { VerifyEmailPage } from './features/auth/VerifyEmailPage';
import { authClient } from './lib/api';
import { useSession } from './lib/session';

export function App() {
  const session = useSession();
  useEffect(() => { void authClient.restore(); }, []);
  if (session.status === 'restoring') return <div className="session-loading"><Brand /><div className="spinner" /><p>Đang mở không gian của bạn…</p></div>;
  return <Routes>
    <Route path="/login" element={session.user ? <Navigate to="/" replace /> : <AuthPage mode="login" key="login" />} />
    <Route path="/register" element={session.user ? <Navigate to="/" replace /> : <AuthPage mode="register" key="register" />} />
    <Route path="/verify-email" element={session.user ? <Navigate to="/" replace /> : <VerifyEmailPage />} />
    <Route path="/forgot-password" element={session.user ? <Navigate to="/" replace /> : <ForgotPasswordPage />} />
    <Route path="/" element={session.user ? <AccountPage user={session.user} /> : <Navigate to="/login" replace />} />
    <Route path="*" element={<Navigate to={session.user ? '/' : '/login'} replace />} />
  </Routes>;
}
