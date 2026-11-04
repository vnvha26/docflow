import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Brand';
import { Field } from '../../components/Field';
import type { Errors } from '../../components/Field';
import { ApiError, authClient, StaleSessionError } from '../../lib/api';
import { clearChallenge, pendingChallenge, saveChallenge } from '../../lib/challenge';
import type { PendingChallenge } from '../../lib/challenge';
import { AuthLayout } from './AuthLayout';

export function CodeChallenge({ challenge, onChallenge, onStartOver }: { challenge: PendingChallenge; onChallenge: (next: PendingChallenge) => void; onStartOver?: () => void }) {
  const reset = challenge.purpose === 'password-reset';
  const navigate = useNavigate();
  const [now, setNow] = useState(Date.now);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [globalError, setGlobalError] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const secondsLeft = Math.max(0, Math.ceil((challenge.expiresAt - now) / 1000));
  const resendLeft = Math.max(0, Math.ceil((challenge.resendAt - now) / 1000));
  const expired = secondsLeft === 0;
  const busy = submitting || resending;
  const countdown = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
  useEffect(() => {
    document.title = `${reset ? 'Đặt lại mật khẩu' : 'Xác minh email'} | DocFlow`;
    mounted.current = true;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [reset]);

  async function resend() {
    if (busy || resendLeft > 0) return;
    setResending(true); setGlobalError(''); setErrors({}); setMessage('');
    try {
      const response = await authClient.resendCode(challenge.challengeId);
      const next = pendingChallenge(response, challenge.purpose);
      saveChallenge(next);
      if (mounted.current) {
        onChallenge(next); setNow(Date.now()); setCode('');
        setMessage(reset ? 'Nếu email thuộc một tài khoản DocFlow, bạn sẽ nhận được mã mới. Hãy kiểm tra hộp thư và thư rác.' : 'Mã mới đã được gửi. Hãy dùng mã trong email mới nhất.');
      }
    } catch (failure) {
      if (mounted.current && !(failure instanceof StaleSessionError)) setGlobalError(failure instanceof Error ? failure.message : 'Chưa thể gửi lại mã. Vui lòng thử lại.');
    } finally { if (mounted.current) setResending(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const next: Errors = {};
    if (expired) next.code = 'Mã đã hết hạn. Gửi lại mã để tiếp tục.';
    else if (!/^\d{6}$/.test(code)) next.code = 'Nhập đủ 6 chữ số trong email xác minh.';
    if (reset && (password.length < 12 || password.length > 128)) next.password = 'Mật khẩu cần từ 12 đến 128 ký tự.';
    if (reset && !confirmPassword) next.confirmPassword = 'Nhập lại mật khẩu để xác nhận.';
    else if (reset && password !== confirmPassword) next.confirmPassword = 'Hai mật khẩu chưa khớp nhau.';
    setErrors(next); setGlobalError(''); setMessage('');
    if (Object.keys(next).length) { requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus()); return; }
    setSubmitting(true);
    try {
      if (reset) {
        await authClient.resetPassword({ challengeId: challenge.challengeId, code, password });
        clearChallenge('password-reset');
        if (mounted.current) navigate('/login', { replace: true, state: { passwordReset: true } });
      } else {
        await authClient.verifyEmail({ challengeId: challenge.challengeId, code });
        clearChallenge('registration');
        if (mounted.current) navigate('/', { replace: true });
      }
    } catch (failure) {
      if (!mounted.current || failure instanceof StaleSessionError) return;
      if (failure instanceof ApiError) {
        setErrors(failure.fieldErrors);
        if (!Object.keys(failure.fieldErrors).length && [400, 401, 410].includes(failure.status)) setErrors({ code: failure.message });
        else setGlobalError(failure.message);
      } else setGlobalError('Chưa thể xác minh mã. Vui lòng thử lại.');
    } finally { if (mounted.current) setSubmitting(false); }
  }

  return <AuthLayout><div className={`auth-content verification-content${reset ? ' reset-content' : ''}`}>
    <Link className="back-link" to="/login"><span aria-hidden="true">←</span> Trở lại đăng nhập</Link>
    <span className="flow-icon"><Icon name={reset ? 'lock' : 'mail'} size={26} /></span>
    <div className="auth-intro"><span className="auth-kicker">{reset ? 'MỘT MẬT KHẨU MỚI, MỘT KHỞI ĐẦU NHẸ' : 'CHỈ CÒN MỘT BƯỚC NỮA'}</span><h2>{reset ? 'Đặt lại mật khẩu.' : 'Kiểm tra email của bạn.'}</h2><p>{reset ? 'Nếu email thuộc một tài khoản DocFlow, hệ thống sẽ gửi mã xác minh đến:' : 'Nhập mã 6 chữ số được gửi đến email:'}<strong className="challenge-email">{challenge.email}</strong>{!reset && <span>Xác minh email để hoàn tất đăng ký tài khoản.</span>}</p></div>
    {globalError && <div className="form-alert" role="alert"><span aria-hidden="true">!</span><p>{globalError}</p></div>}
    {message && <div className="form-success" role="status"><Icon name="check" size={17} /><p>{message}</p></div>}
    <form ref={form} onSubmit={submit} noValidate aria-label={reset ? 'Đặt lại mật khẩu bằng mã email' : 'Xác minh email đăng ký'}>
      <div className={`form-field otp-field${errors.code ? ' has-error' : ''}`}><label htmlFor="verification-code">Mã xác minh</label><div className="input-wrap"><input className="otp-input" id="verification-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" value={code} onChange={(event) => { setCode(event.target.value.replace(/\D/g, '').slice(0, 6)); setErrors((previous) => ({ ...previous, code: undefined })); setGlobalError(''); }} disabled={busy} required aria-invalid={!!errors.code} aria-describedby={`code-hint${errors.code ? ' code-error' : ''}`} /></div><p id="code-hint" className={`field-hint code-expiry${expired ? ' expired' : ''}`}>{expired ? 'Mã đã hết hạn. Gửi lại mã mới bên dưới.' : <>Mã có hiệu lực trong <strong>{countdown}</strong></>}</p>{errors.code && <p className="field-error" id="code-error">{errors.code}</p>}</div>
      {reset && <><Field label="Mật khẩu mới" id="new-password" name="password" icon="lock" type="password" autoComplete="new-password" placeholder="Tạo mật khẩu mới" value={password} onChange={(event) => { setPassword(event.target.value); setErrors((previous) => ({ ...previous, password: undefined })); }} disabled={busy} error={errors.password} hint="Từ 12–128 ký tự. Một cụm từ dài sẽ dễ nhớ hơn." required /><Field label="Xác nhận mật khẩu mới" id="confirm-new-password" name="confirmPassword" icon="lock" type="password" autoComplete="new-password" placeholder="Nhập lại mật khẩu mới" value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); setErrors((previous) => ({ ...previous, confirmPassword: undefined })); }} disabled={busy} error={errors.confirmPassword} required /></>}
      <button className="button-primary" type="submit" disabled={busy || expired}>{submitting ? <><span className="spinner spinner-small" />{reset ? 'Đang đặt lại mật khẩu…' : 'Đang xác minh…'}</> : <>{reset ? 'Đặt lại mật khẩu' : 'Xác minh & tiếp tục'}<Icon name="arrow" size={19} /></>}</button>
    </form>
    <div className="resend-section"><span>Chưa nhận được email?</span><button type="button" onClick={resend} disabled={busy || resendLeft > 0}>{resending ? 'Đang gửi lại…' : resendLeft > 0 ? `Gửi lại sau ${resendLeft}s` : 'Gửi lại mã'}</button></div>
    <p className="spam-note">Hãy kiểm tra cả thư mục thư rác. Chỉ dùng mã trong email mới nhất.</p>
    <div className="change-email">{reset ? <button type="button" onClick={onStartOver} disabled={busy}>Dùng email khác</button> : <Link to="/register" onClick={() => clearChallenge('registration')}>Dùng email khác</Link>}</div>
    <div className="security-note"><Icon name="shield" size={17} /><span>Mã xác minh chỉ dành cho bạn. Đừng chia sẻ với ai.</span></div>
  </div></AuthLayout>;
}
