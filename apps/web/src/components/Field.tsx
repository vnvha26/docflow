import { useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { Icon } from './Brand';

export type FieldName = 'email' | 'password' | 'confirmPassword' | 'displayName' | 'code';
export type Errors = Partial<Record<FieldName, string>>;

export function Field({ label, id, error, hint, icon, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string; error?: string; hint?: string; icon: 'mail' | 'lock' | 'user' }) {
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
