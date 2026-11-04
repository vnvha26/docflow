import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Icon } from '../../components/Brand';
import { ApiError, authClient, StaleSessionError } from '../../lib/api';
import type { User } from '../../lib/api';
import { documentsApi, formatBytes, isLower, lossesOf, privacyLabels } from '../../lib/documents';
import type { PrivacyLevel, StorageUsage } from '../../lib/documents';

const LEVELS: { value: PrivacyLevel; summary: string; detail: string }[] = [
  { value: 'STRUCTURED_ONLY', summary: 'Riêng tư nhất', detail: 'Chỉ giữ loại tài liệu, ngày, số tiền, bên liên quan và việc cần làm. Bản gốc được xóa sau khi xử lý.' },
  { value: 'TEXT_AND_EMBEDDINGS', summary: 'Cân bằng', detail: 'Giữ thêm nội dung chữ và tóm tắt để tìm kiếm, hỏi đáp. Bản gốc được xóa sau khi xử lý.' },
  { value: 'ENCRYPTED_COPY', summary: 'Mặc định · đầy đủ nhất', detail: 'Giữ thêm bản gốc đã mã hóa để xem và tải lại từ máy khác.' },
];

export function PrivacySettings({ user }: { user: User }) {
  const [level, setLevel] = useState<PrivacyLevel>(user.privacyLevel);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const raisingTo3 = level === 'ENCRYPTED_COPY' && user.privacyLevel !== 'ENCRYPTED_COPY';
  const lowering = isLower(level, user.privacyLevel);
  const losses = lossesOf(level, user.privacyLevel);
  const dirty = level !== user.privacyLevel;

  useEffect(() => { setLevel(user.privacyLevel); }, [user.privacyLevel]);

  useEffect(() => {
    let active = true;
    documentsApi.usage().then((value) => { if (active) setUsage(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [user.privacyLevel]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving) return;
    if ((raisingTo3 || lowering) && !confirmed) { setError(lowering ? 'Hãy xác nhận bạn đồng ý xóa dữ liệu ở trên.' : 'Hãy xác nhận bạn đã đọc lưu ý về bản gốc mã hóa.'); return; }
    setSaving(true); setError(''); setMessage('');
    try {
      await authClient.updateAccount({ privacyLevel: level });
      setConfirmed(false);
      setMessage(lowering ? 'Đã hạ mức lưu trữ; dữ liệu không còn được giữ đang được xóa.' : 'Đã lưu mức lưu trữ. Mức mới áp dụng cho các tài liệu tải lên từ bây giờ.');
      if (lowering) documentsApi.usage().then(setUsage).catch(() => undefined);
    } catch (failure) {
      if (failure instanceof StaleSessionError) return;
      setError(failure instanceof ApiError ? (failure.fieldErrors.privacyLevel || failure.message) : 'Chưa thể lưu mức lưu trữ.');
      if (failure instanceof ApiError && failure.status === 409) setLevel(user.privacyLevel);
    } finally { setSaving(false); }
  }

  return <section className="profile-card" id="privacy" aria-labelledby="privacy-title">
    <div className="profile-heading"><div><span className="auth-kicker">QUYỀN RIÊNG TƯ</span><h2 id="privacy-title">Mức lưu trữ</h2></div><span className="profile-icon"><Icon name="shield" size={24} /></span></div>
    <p className="session-note">Chọn những gì DocFlow được giữ trên máy chủ. Mọi tệp đều được mã hóa khi lưu.</p>
    <form className="settings-form" onSubmit={submit} noValidate aria-label="Mức lưu trữ">
      {error && <div className="form-alert" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div>}
      <fieldset className="privacy-options" disabled={saving}>
        <legend className="sr-only">Mức lưu trữ</legend>
        {LEVELS.map((option, index) => <label key={option.value} className={`privacy-option${level === option.value ? ' selected' : ''}`}>
          <input type="radio" name="privacyLevel" value={option.value} checked={level === option.value} onChange={() => { setLevel(option.value); setConfirmed(false); setError(''); setMessage(''); }} />
          <span className="privacy-option-body">
            <span className="privacy-option-title">Mức {index + 1} · {privacyLabels[option.value]}{option.value === user.privacyLevel && <em>Đang dùng</em>}</span>
            <span className="privacy-option-summary">{option.summary}</span>
            <span className="privacy-option-detail">{option.detail}</span>
          </span>
        </label>)}
      </fieldset>
      {raisingTo3 && <div className="privacy-warning">
        <p><strong>Trước khi bật mức 3:</strong></p>
        <ul>
          <li>Bản gốc của các tài liệu tải lên <strong>từ bây giờ</strong> được mã hóa và lưu trên máy chủ, tối đa {usage ? formatBytes(usage.quotaBytes) : '1 GB'}. Tài liệu đã tải lên trước đó không có bản gốc.</li>
          <li>Đây là mã hóa phía máy chủ: bảo vệ khi lộ cơ sở dữ liệu hoặc kho lưu trữ, nhưng không phải mã hóa đầu cuối.</li>
          <li>Bạn có thể xóa bản gốc của từng tài liệu hoặc hạ mức bất cứ lúc nào; bản gốc sẽ bị xóa khỏi máy chủ.</li>
        </ul>
        <label className="confirm-check"><input type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); setError(''); }} />Tôi đã hiểu và muốn lưu bản gốc đã mã hóa.</label>
      </div>}
      {lowering && losses.length > 0 && <div className="privacy-warning">
        <p><strong>Hạ xuống mức {['STRUCTURED_ONLY', 'TEXT_AND_EMBEDDINGS', 'ENCRYPTED_COPY'].indexOf(level) + 1} sẽ xóa:</strong></p>
        <ul>
          {losses.map((loss) => <li key={loss}>{loss}</li>)}
          {user.privacyLevel === 'ENCRYPTED_COPY' && usage && usage.encryptedBytes > 0 && <li>Dung lượng bản gốc được giải phóng: {formatBytes(usage.encryptedBytes)}.</li>}
          <li>Áp dụng cho mọi tài liệu, kể cả tài liệu đã tải lên trước đó.</li>
        </ul>
        <label className="confirm-check"><input type="checkbox" checked={confirmed} onChange={(event) => { setConfirmed(event.target.checked); setError(''); }} />Tôi hiểu dữ liệu trên sẽ bị xóa vĩnh viễn.</label>
      </div>}
      {user.privacyLevel === 'ENCRYPTED_COPY' && level === 'ENCRYPTED_COPY' && <p className="field-hint">
        Bản gốc được mã hóa phía máy chủ trước khi lưu{usage && <> · đang dùng {formatBytes(usage.encryptedBytes)} / {formatBytes(usage.quotaBytes)}</>}.
        Muốn riêng tư hơn, chọn mức 1 hoặc 2.
      </p>}
      <div className="profile-bottom">
        <p role="status">{message && <><Icon name="check" size={16} /><span>{message}</span></>}</p>
        <button type="submit" className="button-primary button-compact" disabled={saving || !dirty}>{saving ? 'Đang lưu…' : 'Lưu mức lưu trữ'}</button>
      </div>
    </form>
  </section>;
}
