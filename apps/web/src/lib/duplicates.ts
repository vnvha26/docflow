export type MatchState = 'full' | 'no-original' | 'original-trashed' | 'trashed';
export type DuplicateChoice = 'new' | 'skip' | 'supplement' | 'restore';

export interface DuplicateMatch {
  documentId: string;
  title: string;
  folderId: string | null;
  location: string | null;
  state: MatchState;
  sameFolder: boolean;
  trashId: string | null;
  trashFolder?: string | null;
}

export interface DuplicateCheck {
  situation: 'new' | 'auto-supplement' | 'ask';
  primary: DuplicateMatch | null;
  matches: DuplicateMatch[];
  options: DuplicateChoice[];
}

const quoted = (name: string) => `“${name}”`;
const UNFILED = 'Chưa phân loại';

export const placeOf = (match: Pick<DuplicateMatch, 'location'>) => quoted(match.location ?? UNFILED);

export function defaultChoice(check: Pick<DuplicateCheck, 'options'>): DuplicateChoice {
  return check.options.find((option) => option === 'restore' || option === 'supplement') ?? 'skip';
}

export function choiceLabel(choice: DuplicateChoice, check: Pick<DuplicateCheck, 'primary'>): string {
  const primary = check.primary;
  if (choice === 'skip') return 'Không tải';
  if (choice === 'restore') return primary?.trashFolder ? `Khôi phục thư mục ${quoted(primary.trashFolder)} từ thùng rác` : 'Khôi phục từ thùng rác';
  if (choice === 'supplement') return primary ? `Bổ sung bản gốc cho ${quoted(primary.title)} ở ${placeOf(primary)}` : 'Bổ sung bản gốc';
  return primary?.state === 'no-original' ? 'Tải mới vào đây' : 'Tải mới';
}

export function situationText(check: Pick<DuplicateCheck, 'primary' | 'matches'>): string {
  const primary = check.primary;
  if (!primary) return '';
  const where = primary.sameFolder ? 'ngay trong thư mục này' : `ở ${placeOf(primary)}`;
  const main = primary.state === 'trashed' && primary.trashFolder
    ? `Tài liệu ${quoted(primary.title)} có cùng nội dung nằm trong thư mục ${quoted(primary.trashFolder)} đang ở thùng rác; khôi phục sẽ trả lại cả thư mục đó.`
    : primary.state === 'trashed' ? `Tài liệu ${quoted(primary.title)} có cùng nội dung đang nằm trong thùng rác (vị trí cũ: ${placeOf(primary)}).`
    : primary.state === 'original-trashed' ? `Bản gốc của ${quoted(primary.title)} (${where}) đang nằm trong thùng rác.`
      : primary.state === 'no-original' ? `Tài liệu ${quoted(primary.title)} ${where} có cùng nội dung nhưng không còn bản gốc.`
        : `Tệp này đã có: ${quoted(primary.title)} ${where}.`;
  const others = check.matches.filter((match) => match.documentId !== primary.documentId);
  if (!others.length) return main;
  const places = others.map((match) => `${quoted(match.title)} (${match.state === 'trashed' ? 'thùng rác' : match.location ?? UNFILED})`);
  return `${main} Cũng có ở: ${places.join(', ')}.`;
}

export function applyToAll<K extends string>(questions: readonly { key: K; check: Pick<DuplicateCheck, 'options'> }[], choice: DuplicateChoice, current: Record<K, DuplicateChoice>): Record<K, DuplicateChoice> {
  const next = { ...current };
  for (const question of questions) {
    if (question.check.options.includes(choice)) next[question.key] = choice;
  }
  return next;
}

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
