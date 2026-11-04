import type { ReactNode } from 'react';
import { Brand, DocumentArt, Icon } from '../../components/Brand';

export function AuthLayout({ children }: { children: ReactNode }) {
  return <main className="auth-shell">
    <section className="story-panel" aria-label="Về DocFlow">
      <Brand />
      <div className="story-content"><span className="eyebrow"><span /> ÍT BỘN BỀ HƠN, NHIỀU THẢNH THƠI HƠN</span><h1>Tài liệu gọn.<br />Cuộc sống nhẹ<span>.</span></h1><p>Một không gian riêng cho tài liệu của bạn.<br />Để những điều quan trọng luôn trong tầm tay.</p><DocumentArt /></div>
      <div className="story-footer"><span><Icon name="shield" size={17} /> Không gian riêng. An tâm mỗi ngày.</span><span>© 2026 DocFlow</span></div>
    </section>
    <section className="form-panel"><div className="mobile-brand"><Brand /></div>{children}<p className="form-footer">Được tạo ra để cuộc sống nhẹ nhàng hơn.<span className="footer-spark">✳</span></p></section>
  </main>;
}
