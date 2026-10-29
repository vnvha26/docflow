import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, InputHTMLAttributes, ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, authClient, StaleSessionError } from './lib/api';
import type { User } from './lib/api';
import { clearChallenge, pendingChallenge, readChallenge, saveChallenge } from './lib/challenge';
import type { PendingChallenge } from './lib/challenge';
import { Brand, DocumentArt, Icon } from './components/Brand';

function useSession() { return useSyncExternalStore(authClient.subscribe, authClient.getSnapshot); }

export function App() {
  const session = useSession();
  useEffect(() => { void authClient.restore(); }, []);
  if (session.status === 'restoring') return <div className="session-loading"><Brand /><div className="spinner" /><p>Đang mở không gian của bạn…</p></div>;
  return <Routes>
    <Route path="/login" element={session.user ? <Navigate to="/" replace /> : <AuthPage mode="login" key="login" />} />
    <Route path="/register" element={session.user ? <Navigate to="/" replace /> : <AuthPage mode="register" key="register" />} />
    <Route path="/verify-email" element={session.user ? <Navigate to="/" replace /> : <VerifyEmailPage />} />
    <Route path="/forgot-password" element={session.user ? <Navigate to="/" replace /> : <ForgotPasswordPage />} />
    <Route path="/" element={session.user ? <AccountHome user={session.user} /> : <Navigate to="/login" replace />} />
    <Route path="*" element={<Navigate to={session.user ? '/' : '/login'} replace />} />
  </Routes>;
}

function AuthLayout({ children }: { children: ReactNode }) {
  return <main className="auth-shell">
    <section className="story-panel" aria-label="Về DocFlow">
      <Brand />
      <div className="story-content"><span className="eyebrow"><span /> ÍT BỘN BỀ HƠN, NHIỀU THẢNH THƠI HƠN</span><h1>Tài liệu gọn.<br />Cuộc sống nhẹ<span>.</span></h1><p>Một không gian riêng cho tài liệu của bạn.<br />Để những điều quan trọng luôn trong tầm tay.</p><DocumentArt /></div>
      <div className="story-footer"><span><Icon name="shield" size={17} /> Không gian riêng. An tâm mỗi ngày.</span><span>© 2026 DocFlow</span></div>
    </section>
    <section className="form-panel"><div className="mobile-brand"><Brand /></div>{children}<p className="form-footer">Được tạo ra để cuộc sống nhẹ nhàng hơn.<span className="footer-spark">✳</span></p></section>
  </main>;
}

type FieldName = 'email' | 'password' | 'confirmPassword' | 'displayName' | 'code';
type Errors = Partial<Record<FieldName, string>>;

function Field({ label, id, error, hint, icon, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string; error?: string; hint?: string; icon: 'mail' | 'lock' | 'user' }) {
  const [visible, setVisible] = useState(false);
  const password = props.type === 'password';
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined;
  return <div className={`form-field${error ? ' has-error' : ''}`}>
    <label htmlFor={id}>{label}</label>
    <div className="input-wrap"><span className="input-icon"><Icon name={icon} size={18} /></span><input {...props} id={id} type={password && visible ? 'text' : props.type} aria-invalid={!!error} aria-describedby={describedBy} />{password && <button type="button" className="password-toggle" onClick={() => setVisible(!visible)} aria-label={visible ? `Ẩn ${label.toLowerCase()}` : `Hiện ${label.toLowerCase()}`} aria-pressed={visible}><Icon name={visible ? 'eye-off' : 'eye'} size={19} /></button>}</div>
    {hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}
    {error && <p className="field-error" id={`${id}-error`}>{error}</p>}
  </div>;
}

function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const register = mode === 'register';
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [values, setValues] = useState({ email: '', password: '', confirmPassword: '', displayName: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [globalError, setGlobalError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  useEffect(() => { document.title = `${register ? 'Tạo tài khoản' : 'Đăng nhập'} | DocFlow`; mounted.current = true; return () => { mounted.current = false; }; }, [register]);

  function validate(): Errors {
    const next: Errors = {};
    if (!values.email.trim()) next.email = 'Bạn chưa nhập email.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) next.email = 'Nhập một địa chỉ email hợp lệ.';
    if (!values.password) next.password = 'Bạn chưa nhập mật khẩu.';
    else if (register && (values.password.length < 12 || values.password.length > 128)) next.password = 'Mật khẩu cần từ 12 đến 128 ký tự.';
    else if (values.password.length > 128) next.password = 'Mật khẩu tối đa 128 ký tự.';
    if (register && !values.confirmPassword) next.confirmPassword = 'Nhập lại mật khẩu để xác nhận.';
    else if (register && values.password !== values.confirmPassword) next.confirmPassword = 'Hai mật khẩu chưa khớp nhau.';
    if (register && values.displayName.trim().length > 100) next.displayName = 'Tên hiển thị tối đa 100 ký tự.';
    return next;
  }

  function update(field: FieldName, value: string) {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setGlobalError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const next = validate();
    setErrors(next);
    setGlobalError('');
    if (Object.keys(next).length) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setSubmitting(true);
    try {
      if (register) {
        const response = await authClient.startRegistration({ email: values.email.trim(), password: values.password, ...(values.displayName.trim() ? { displayName: values.displayName.trim() } : {}) });
        saveChallenge(pendingChallenge(response, 'registration'));
        if (mounted.current) navigate('/verify-email');
      } else {
        await authClient.authenticate('login', { email: values.email.trim(), password: values.password });
        clearChallenge('registration');
        if (mounted.current) navigate('/', { replace: true });
      }
    } catch (error) {
      if (!mounted.current || error instanceof StaleSessionError) return;
      if (error instanceof ApiError) {
        setErrors(error.fieldErrors);
        setGlobalError(error.message);
      } else setGlobalError('Có lỗi xảy ra. Vui lòng thử lại.');
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  return <AuthLayout><div className={`auth-content${register ? ' register-content' : ''}`}>
    <nav className="auth-tabs" aria-label="Tài khoản"><Link to="/login" className={!register ? 'active' : ''} aria-current={!register ? 'page' : undefined}>Đăng nhập</Link><Link to="/register" className={register ? 'active' : ''} aria-current={register ? 'page' : undefined}>Tạo tài khoản</Link></nav>
    <div className="auth-intro"><span className="auth-kicker">{register ? 'MỘT KHỞI ĐẦU NHẸ NHÀNG' : 'KHÔNG GIAN QUEN THUỘC CỦA BẠN'}</span><h2>{register ? 'Bắt đầu cùng DocFlow.' : 'Chào mừng trở lại.'}</h2><p>{register ? 'Tạo tài khoản để bắt đầu sắp xếp những điều quan trọng.' : 'Đăng nhập để trở về không gian tài liệu của bạn.'}</p></div>
    {!register && location.state?.passwordReset && <div className="form-success" role="status"><Icon name="check" size={17} /><p>Mật khẩu đã được đặt lại. Đăng nhập bằng mật khẩu mới để tiếp tục.</p></div>}
    {session.expired && !globalError && <div className="form-notice" role="status">Phiên đăng nhập đã kết thúc. Đăng nhập lại để tiếp tục.</div>}
    {globalError && <div className="form-alert" role="alert"><span aria-hidden="true">!</span><p>{globalError}</p></div>}
    <form ref={formRef} onSubmit={submit} noValidate aria-label={register ? 'Tạo tài khoản DocFlow' : 'Đăng nhập DocFlow'}>
      {register && <Field label="Tên hiển thị (không bắt buộc)" id="displayName" name="displayName" icon="user" type="text" autoComplete="name" placeholder="Bạn muốn được gọi là gì?" value={values.displayName} onChange={(e) => update('displayName', e.target.value)} error={errors.displayName} disabled={submitting} maxLength={100} />}
      <Field label="Địa chỉ email" id="email" name="email" icon="mail" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} placeholder="ban@example.com" value={values.email} onChange={(e) => update('email', e.target.value)} error={errors.email} disabled={submitting} required maxLength={254} />
      <Field label="Mật khẩu" id="password" name="password" icon="lock" type="password" autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? 'Tạo mật khẩu của bạn' : 'Nhập mật khẩu của bạn'} value={values.password} onChange={(e) => update('password', e.target.value)} error={errors.password} disabled={submitting} required hint={register ? 'Từ 12–128 ký tự. Một cụm từ dài sẽ dễ nhớ hơn.' : undefined} />
      {register && <Field label="Xác nhận mật khẩu" id="confirmPassword" name="confirmPassword" icon="lock" type="password" autoComplete="new-password" placeholder="Nhập lại mật khẩu" value={values.confirmPassword} onChange={(e) => update('confirmPassword', e.target.value)} error={errors.confirmPassword} disabled={submitting} required />}
      {!register && <div className="forgot-link"><Link to="/forgot-password">Quên mật khẩu?</Link></div>}
      <button className="button-primary" type="submit" disabled={submitting}>{submitting ? <><span className="spinner spinner-small" />{register ? 'Đang tạo tài khoản…' : 'Đang đăng nhập…'}</> : <>{register ? 'Tạo tài khoản' : 'Đăng nhập'}<Icon name="arrow" size={19} /></>}</button>
    </form>
    {register && <p className="registration-note">Bạn sẽ nhận mã xác minh qua email để hoàn tất đăng ký.</p>}
    <p className="auth-switch">{register ? 'Đã có tài khoản?' : 'Bạn mới đến DocFlow?'} <Link to={register ? '/login' : '/register'}>{register ? 'Đăng nhập' : 'Tạo tài khoản'}<span aria-hidden="true"> ↗</span></Link></p>
    <div className="security-note"><Icon name="shield" size={17} /><span>Đăng nhập an toàn. Không gian dành riêng cho bạn.</span></div>
  </div></AuthLayout>;
}

function VerifyEmailPage() {
  const [challenge, setChallenge] = useState(() => readChallenge('registration'));
  if (!challenge) return <Navigate to="/register" replace />;
  return <CodeChallenge challenge={challenge} onChallenge={setChallenge} />;
}

function ForgotPasswordPage() {
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

function CodeChallenge({ challenge, onChallenge, onStartOver }: { challenge: PendingChallenge; onChallenge: (next: PendingChallenge) => void; onStartOver?: () => void }) {
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

function AccountHome({ user }: { user: User }) {
  const [profile, setProfile] = useState(user);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const name = profile.displayName || profile.email.split('@')[0];
  const initials = name.trim().split(/\s+/).slice(-2).map((part) => part[0]).join('').toLocaleUpperCase('vi');
  const privacyLabels = { STRUCTURED_ONLY: 'Chỉ thông tin có cấu trúc', TEXT_AND_EMBEDDINGS: 'Nội dung & tìm kiếm', ENCRYPTED_COPY: 'Bản gốc được mã hóa' };
  useEffect(() => { document.title = 'Tài khoản của bạn | DocFlow'; }, []);

  async function logout() {
    setError(''); setLoggingOut(true);
    try { await authClient.logout(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Chưa thể đăng xuất. Vui lòng thử lại.'); }
    finally { setLoggingOut(false); }
  }

  async function refreshProfile() {
    setChecking(true); setChecked(false); setError('');
    try { setProfile(await authClient.request<User>('/auth/me')); setChecked(true); }
    catch (failure) { if (!(failure instanceof StaleSessionError)) setError(failure instanceof Error ? failure.message : 'Không thể cập nhật thông tin.'); }
    finally { setChecking(false); }
  }

  return <div className="account-shell"><header className="account-header"><Brand /><div className="header-right"><span className="personal-tag"><span /> Không gian cá nhân</span><details className="account-menu"><summary aria-label={`Tài khoản ${name}`}><span className="avatar">{initials}</span><span className="menu-name">{name}</span><Icon name="chevron" size={16} /></summary><div className="account-dropdown"><p>Đang đăng nhập bằng</p><strong>{user.email}</strong><button onClick={logout} disabled={loggingOut}><Icon name="logout" size={17} />{loggingOut ? 'Đang đăng xuất…' : 'Đăng xuất'}</button></div></details></div></header>
    <main className="account-main"><section className="welcome-card"><div><span className="eyebrow"><span /> CHÀO MỪNG VỀ NHÀ</span><h1>Chào {name}<span>.</span></h1><p>Mọi khởi đầu gọn gàng đều từ một không gian riêng.<br />Tài khoản DocFlow của bạn đã sẵn sàng.</p><span className="welcome-status"><span><Icon name="check" size={13} /></span> Bạn đã đăng nhập thành công</span></div><DocumentArt compact /></section>
      {error && <div className="form-alert account-alert" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div>}
      <section className="profile-card" aria-labelledby="profile-title"><div className="profile-heading"><div><span className="auth-kicker">THÔNG TIN TÀI KHOẢN</span><h2 id="profile-title">Một chút về bạn</h2></div><span className="profile-icon"><Icon name="user" size={24} /></span></div><dl><div><dt>Tên hiển thị</dt><dd>{profile.displayName || 'Chưa đặt tên'}</dd></div><div><dt>Địa chỉ email</dt><dd>{profile.email}</dd></div><div><dt>Múi giờ</dt><dd>{profile.timezone}</dd></div><div><dt>Mức lưu trữ</dt><dd>{privacyLabels[profile.privacyLevel]}</dd></div></dl><div className="profile-bottom"><p><Icon name="shield" size={18} /><span>Thông tin được lấy từ tài khoản của bạn.</span></p><button type="button" className="button-secondary" onClick={refreshProfile} disabled={checking}>{checking ? 'Đang cập nhật…' : 'Làm mới thông tin'}{checked ? <Icon name="check" size={16} /> : <Icon name="arrow" size={16} />}</button></div><span className="sr-only" role="status">{checked ? 'Đã cập nhật thông tin tài khoản.' : ''}</span></section>
      <div className="account-signout"><span>Đã xong việc hôm nay?</span><button type="button" onClick={logout} disabled={loggingOut}>{loggingOut ? 'Đang đăng xuất…' : 'Đăng xuất an toàn'}<Icon name="logout" size={16} /></button></div>
    </main><footer className="account-footer"><span>© 2026 DocFlow</span><span>Tài liệu gọn. Cuộc sống nhẹ.</span></footer></div>;
}
