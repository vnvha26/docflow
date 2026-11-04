import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Brand';
import { Field } from '../../components/Field';
import type { Errors, FieldName } from '../../components/Field';
import { ApiError, authClient, StaleSessionError } from '../../lib/api';
import { clearChallenge, pendingChallenge, saveChallenge } from '../../lib/challenge';
import { useSession } from '../../lib/session';
import { AuthLayout } from './AuthLayout';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
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
    {register && <p className="registration-note">Bạn sẽ nhận mã xác minh qua email để hoàn tất đăng ký. Mặc định DocFlow lưu cả bản gốc đã mã hóa để bạn tải lại từ máy khác; có thể đổi trong Cài đặt.</p>}
    <p className="auth-switch">{register ? 'Đã có tài khoản?' : 'Bạn mới đến DocFlow?'} <Link to={register ? '/login' : '/register'}>{register ? 'Đăng nhập' : 'Tạo tài khoản'}<span aria-hidden="true"> ↗</span></Link></p>
    <div className="security-note"><Icon name="shield" size={17} /><span>Đăng nhập an toàn. Không gian dành riêng cho bạn.</span></div>
  </div></AuthLayout>;
}
