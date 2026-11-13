export type MatchState = 'full' | 'no-original' | 'original-trashed' | 'trashed';
export type DuplicateOption = 'new' | 'skip' | 'supplement' | 'restore';
export type DuplicateSituation = 'new' | 'auto-supplement' | 'ask';

export interface DuplicateMatch {
  documentId: string;
  title: string;
  folderId: string | null;
  location: string | null;
  state: MatchState;
  sameFolder: boolean;
  trashId: string | null;
}

export interface DuplicateCheck {
  situation: DuplicateSituation;
  primary: DuplicateMatch | null;
  matches: DuplicateMatch[];
  options: DuplicateOption[];
}

export interface Candidate {
  documentId: string;
  title: string;
  folderId: string | null;
  location: string | null;
  state: MatchState;
  trashId: string | null;
  createdAt: Date;
}

const STATE_ORDER: readonly MatchState[] = ['no-original', 'original-trashed', 'full', 'trashed'];
const OPTIONS: Record<MatchState, DuplicateOption[]> = {
  full: ['new', 'skip'],
  'no-original': ['supplement', 'new', 'skip'],
  'original-trashed': ['restore', 'new', 'skip'],
  trashed: ['restore', 'new', 'skip'],
};

export function rankCandidates<T extends Candidate>(candidates: readonly T[], folderId: string | null): T[] {
  return [...candidates].sort((left, right) =>
    Number(right.folderId === folderId) - Number(left.folderId === folderId)
    || STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state)
    || left.createdAt.getTime() - right.createdAt.getTime()
    || left.documentId.localeCompare(right.documentId));
}

export function classifyDuplicates(candidates: readonly Candidate[], folderId: string | null): DuplicateCheck {
  const matches = rankCandidates(candidates, folderId).map((candidate): DuplicateMatch => ({
    documentId: candidate.documentId, title: candidate.title, folderId: candidate.folderId, location: candidate.location,
    state: candidate.state, sameFolder: candidate.folderId === folderId, trashId: candidate.trashId,
  }));
  const primary = matches[0] ?? null;
  if (!primary) return { situation: 'new', primary: null, matches: [], options: [] };
  if (primary.state === 'no-original' && primary.sameFolder) return { situation: 'auto-supplement', primary, matches, options: [] };
  return { situation: 'ask', primary, matches, options: OPTIONS[primary.state] };
}
