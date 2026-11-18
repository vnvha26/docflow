import { Link } from 'react-router-dom';

export function Brand({ inverse = false }: { inverse?: boolean }) {
  return <Link className={`brand${inverse ? ' brand-inverse' : ''}`} to="/" aria-label="DocFlow — Trang chủ">
    <span className="brand-symbol" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M9 5h10l6 6v16H9z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><path d="M19 5v7h6M13 17h8m-8 5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg></span>
    <span>Doc<span className="brand-light">Flow</span><span className="brand-period">.</span></span>
  </Link>;
}

export type IconName = 'arrow' | 'eye' | 'eye-off' | 'shield' | 'mail' | 'lock' | 'user' | 'logout' | 'check' | 'chevron' | 'file' | 'upload' | 'download' | 'folder' | 'more' | 'summary' | 'trash' | 'folder-plus' | 'restore' | 'close';

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths = {
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    'eye-off': <><path d="m3 3 18 18M10.5 5.1A11 11 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 3.9M6.1 6.1A18 18 0 0 0 2 12s3.5 7 10 7c2.1 0 3.8-.7 5.3-1.7M10 10a3 3 0 0 0 4 4" /></>,
    shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="m8.5 12 2.3 2.3 4.7-4.6" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></>,
    logout: <><path d="M10 4H5v16h5m4-12 4 4-4 4m-5-4h12" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m7 10 5 5 5-5" />,
    file: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6m-6 4h4" /></>,
    upload: <><path d="M12 16V4m-5 5 5-5 5 5" /><path d="M5 15v4h14v-4" /></>,
    download: <><path d="M12 4v12m-5-5 5 5 5-5" /><path d="M5 15v4h14v-4" /></>,
    folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
    more: <><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>,
    summary: <><path d="M5 5h14M5 10h14M5 15h9M5 20h6" /></>,
    trash: <><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
    'folder-plus': <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10v6m-3-3h6" /></>,
    restore: <><path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.7" /><path d="M4 4v4.7h4.7" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function DocumentArt({ compact = false }: { compact?: boolean }) {
  return <div className={`document-art${compact ? ' document-art-compact' : ''}`} aria-hidden="true">
    <div className="art-orbit art-orbit-one" /><div className="art-orbit art-orbit-two" />
    <div className="art-dot art-dot-one" /><div className="art-dot art-dot-two" />
    <div className="paper paper-back"><span className="paper-fold" /><div className="paper-line long" /><div className="paper-line" /><div className="paper-line short" /></div>
    <div className="paper paper-front"><div className="paper-heading"><span className="mini-document"><svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h4" /></svg></span><span className="paper-heading-lines"><i /><i /></span></div><div className="paper-line long" /><div className="paper-line" /><div className="paper-line long" /><div className="paper-divider" /><div className="paper-row"><span className="paper-check">✓</span><span className="paper-line" /></div><div className="paper-row"><span className="paper-check">✓</span><span className="paper-line short" /></div><div className="paper-stamp"><Icon name="check" size={14} /> Đã sắp xếp</div></div>
    <div className="art-shield"><Icon name="shield" size={29} /></div>
    <div className="art-leaf"><svg viewBox="0 0 60 90"><path d="M29 83C14 57 5 45 10 20c25 3 32 23 19 63Z" fill="#71967b" /><path d="M29 83C25 58 32 25 54 15c10 27-3 47-25 68Z" fill="#a4b79a" /><path d="M29 88 20 37m9 48 15-46" stroke="#416a52" strokeWidth="1.5" fill="none" /></svg></div>
  </div>;
}
