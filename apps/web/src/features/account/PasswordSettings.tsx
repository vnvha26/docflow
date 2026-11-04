import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Icon } from '../../components/Brand';
import { Field } from '../../components/Field';
import { ApiError, authClient, StaleSessionError } from '../../lib/api';

type PasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword';
const empty: Record<PasswordField, string> = { currentPassword: '', newPassword: '', confirmPassword: '' };

export function PasswordSettings({ onChanged }: { onChanged: () => void }) {
  const [values, setValues] = useState(empty);
  const [errors, setErrors] = useState<Partial<Record<PasswordField, string>>>({});
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  function update(field: PasswordField, value: string) {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setError(''); setMessage('');
  }

  function validate() {
    const next: Partial<Record<PasswordField, string>> = {};
    if (!values.currentPassword) next.currentPassword = 'Nhập mật khẩu hiện tại.';
    if (values.newPassword.length < 12 || values.newPassword.length > 128) next.newPassword = 'Mật khẩu mới cần từ 12 đến 128 ký tự.';
    else if (values.newPassword === values.currentPassword) next.newPassword = 'Mật khẩu mới phải khác mật khẩu hiện tại.';
    if (!values.confirmPassword) next.confirmPassword = 'Nhập lại mật khẩu mới để xác nhận.';
    else if (values.confirmPassword !== values.newPassword) next.confirmPassword = 'Hai mật khẩu chưa khớp nhau.';
    return next;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const next = validate();
    setErrors(next); setError(''); setMessage('');
    if (Object.keys(next).length) {
      requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setSaving(true);
    try {
      await authClient.changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword });
      setValues(empty);
      setMessage('Đã đổi mật khẩu. Các thiết bị khác đã được đăng xuất.');
      onChanged();
    } catch (failure) {
      if (failure instanceof StaleSessionError) return;
      if (failure instanceof ApiError && Object.keys(failure.fieldErrors).length) setErrors(failure.fieldErrors);
      else setError(failure instanceof Error ? failure.message : 'Chưa thể đổi mật khẩu. Vui lòng thử lại.');
    } finally { setSaving(false); }
  }

  return <section className="profile-card" aria-labelledby="password-title">
    <div className="profile-heading"><div><span className="auth-kicker">BẢO MẬT TÀI KHOẢN</span><h2 id="password-title">Đổi mật khẩu</h2></div><span className="profile-icon"><Icon name="lock" size={24} /></span></div>
    <p className="session-note">Sau khi đổi, mọi thiết bị khác sẽ bị đăng xuất. Thiết bị này vẫn giữ đăng nhập.</p>
    <form ref={form} className="settings-form" onSubmit={submit} noValidate aria-label="Đổi mật khẩu">
      {error && <div className="form-alert" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div>}
      {/* Hidden username helps password managers update the right saved credential. */}
      <input type="email" name="username" autoComplete="username" hidden readOnly value={authClient.getSnapshot().user?.email ?? ''} />
      <div className="settings-grid settings-grid-three">
        <Field label="Mật khẩu hiện tại" id="current-password" name="currentPassword" icon="lock" type="password" autoComplete="current-password" value={values.currentPassword} onChange={(event) => update('currentPassword', event.target.value)} disabled={saving} error={errors.currentPassword} />
        <Field label="Mật khẩu mới" id="settings-new-password" name="newPassword" icon="lock" type="password" autoComplete="new-password" value={values.newPassword} onChange={(event) => update('newPassword', event.target.value)} disabled={saving} error={errors.newPassword} hint="Từ 12–128 ký tự." />
        <Field label="Xác nhận mật khẩu mới" id="settings-confirm-password" name="confirmPassword" icon="lock" type="password" autoComplete="new-password" value={values.confirmPassword} onChange={(event) => update('confirmPassword', event.target.value)} disabled={saving} error={errors.confirmPassword} />
      </div>
      <div className="profile-bottom">
        <p role="status">{message && <><Icon name="check" size={16} /><span>{message}</span></>}</p>
        <button type="submit" className="button-primary button-compact" disabled={saving}>{saving ? 'Đang đổi mật khẩu…' : 'Đổi mật khẩu'}</button>
      </div>
    </form>
  </section>;
}
