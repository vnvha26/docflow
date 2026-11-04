import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Brand';
import { Field } from '../../components/Field';
import { ApiError, authClient, StaleSessionError } from '../../lib/api';
import { clearChallenge, pendingChallenge, readChallenge, saveChallenge } from '../../lib/challenge';
import { AuthLayout } from './AuthLayout';
import { CodeChallenge } from './CodeChallenge';

export function ForgotPasswordPage() {
  const [challenge, setChallenge] = useState(() => readChallenge('password-reset'));
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { document.title = 'Quên mật khẩu | DocFlow'; mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(''); setFieldError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setFieldError('Nhập địa chỉ email bạn dùng cho tài khoản.'); return; }
    setSubmitting(true);
    try {
      const response = await authClient.forgotPassword(email.trim());
      const pending = pendingChallenge(response, 'password-reset');
      saveChallenge(pending);
      if (mounted.current) setChallenge(pending);
    } catch (failure) {
      if (!mounted.current || failure instanceof StaleSessionError) return;
      if (failure instanceof ApiError) { setFieldError(failure.fieldErrors.email || ''); setError(failure.message); }
      else setError('Chưa thể gửi yêu cầu. Vui lòng thử lại.');
    } finally { if (mounted.current) setSubmitting(false); }
  }

  if (challenge) return <CodeChallenge challenge={challenge} onChallenge={setChallenge} onStartOver={() => { clearChallenge('password-reset'); setChallenge(null); }} />;
  return <AuthLayout><div className="auth-content recovery-content"><Link className="back-link" to="/login"><span aria-hidden="true">←</span> Trở lại đăng nhập</Link><span className="flow-icon"><Icon name="lock" size={26} /></span><div className="auth-intro"><span className="auth-kicker">TÌM LẠI KHÔNG GIAN CỦA BẠN</span><h2>Quên mật khẩu?</h2><p>Không sao cả. Nhập email của bạn để nhận mã đặt lại mật khẩu.</p></div>{error && <div className="form-alert" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div>}<form onSubmit={submit} noValidate aria-label="Yêu cầu đặt lại mật khẩu"><Field label="Địa chỉ email" id="recovery-email" name="email" type="email" icon="mail" value={email} onChange={(event) => { setEmail(event.target.value); setFieldError(''); setError(''); }} placeholder="ban@example.com" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} required disabled={submitting} error={fieldError} maxLength={254} /><button className="button-primary" type="submit" disabled={submitting}>{submitting ? <><span className="spinner spinner-small" />Đang gửi yêu cầu…</> : <>Gửi mã xác minh<Icon name="arrow" size={19} /></>}</button></form><div className="security-note"><Icon name="shield" size={17} /><span>Mã xác minh chỉ dành cho bạn. Đừng chia sẻ với ai.</span></div></div></AuthLayout>;
}
