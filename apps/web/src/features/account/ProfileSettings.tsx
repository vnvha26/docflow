import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Icon } from '../../components/Brand';
import { Field } from '../../components/Field';
import { ApiError, authClient, StaleSessionError } from '../../lib/api';
import type { User } from '../../lib/api';
import { canonicalZone, deviceZone, timeZoneOptions } from './timezones';

type ProfileErrors = Partial<Record<'displayName' | 'timezone', string>>;

export function ProfileSettings({ user }: { user: User }) {
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [timezone, setTimezone] = useState(user.timezone);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const options = useMemo(() => timeZoneOptions(timezone), [timezone]);
  const device = deviceZone();
  const changes: { displayName?: string; timezone?: string } = {};
  if (displayName.trim() !== (user.displayName ?? '')) changes.displayName = displayName.trim();
  if (timezone !== user.timezone) changes.timezone = timezone;
  const dirty = Object.keys(changes).length > 0;
  const deviceDiffers = device !== null && canonicalZone(device) !== canonicalZone(timezone);

  function touch() { setMessage(''); setError(''); }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !dirty) return;
    if (displayName.trim().length > 100) { setErrors({ displayName: 'Tên hiển thị tối đa 100 ký tự.' }); return; }
    setSaving(true); setErrors({}); touch();
    try {
      const saved = await authClient.updateAccount(changes);
      setDisplayName(saved.displayName ?? '');
      setTimezone(saved.timezone);
      setMessage('Đã lưu thay đổi.');
    } catch (failure) {
      if (failure instanceof StaleSessionError) return;
      if (failure instanceof ApiError) { setErrors(failure.fieldErrors); setError(failure.message); }
      else setError('Chưa thể lưu thay đổi. Vui lòng thử lại.');
    } finally { setSaving(false); }
  }

  return <section className="profile-card" aria-labelledby="profile-title">
    <div className="profile-heading"><div><span className="auth-kicker">THÔNG TIN TÀI KHOẢN</span><h2 id="profile-title">Một chút về bạn</h2></div><span className="profile-icon"><Icon name="user" size={24} /></span></div>
    <form className="settings-form" onSubmit={submit} noValidate aria-label="Thông tin tài khoản">
      {error && !Object.keys(errors).length && <div className="form-alert" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div>}
      <div className="settings-grid">
        <Field label="Tên hiển thị" id="settings-display-name" name="displayName" icon="user" type="text" autoComplete="name" maxLength={100} placeholder="Bạn muốn được gọi là gì?" value={displayName} onChange={(event) => { setDisplayName(event.target.value); setErrors((previous) => ({ ...previous, displayName: undefined })); touch(); }} disabled={saving} error={errors.displayName} />
        <div className={`form-field${errors.timezone ? ' has-error' : ''}`}>
          <label htmlFor="settings-timezone">Múi giờ</label>
          <div className="input-wrap select-wrap">
            <select id="settings-timezone" name="timezone" value={timezone} onChange={(event) => { setTimezone(event.target.value); setErrors((previous) => ({ ...previous, timezone: undefined })); touch(); }} disabled={saving} aria-invalid={!!errors.timezone} aria-describedby={`settings-timezone-hint${errors.timezone ? ' settings-timezone-error' : ''}`}>
              {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <span className="select-chevron"><Icon name="chevron" size={16} /></span>
          </div>
          <p className="field-hint" id="settings-timezone-hint">Dùng để tính ngày đến hạn và giờ gửi nhắc việc.{deviceDiffers && <> <button type="button" className="text-button" onClick={() => { setTimezone(device!); touch(); }} disabled={saving}>Dùng múi giờ của thiết bị ({device})</button></>}</p>
          {errors.timezone && <p className="field-error" id="settings-timezone-error">{errors.timezone}</p>}
        </div>
      </div>
      <dl className="settings-readonly"><div><dt>Địa chỉ email</dt><dd>{user.email}</dd></div></dl>
      <div className="profile-bottom">
        <p role="status">{message ? <><Icon name="check" size={16} /><span>{message}</span></> : <span>Email chưa thể thay đổi.</span>}</p>
        <button type="submit" className="button-primary button-compact" disabled={saving || !dirty}>{saving ? 'Đang lưu…' : 'Lưu thay đổi'}</button>
      </div>
    </form>
  </section>;
}
