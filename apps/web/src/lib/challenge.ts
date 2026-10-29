import type { ChallengeResponse } from './api.ts';

export type ChallengePurpose = 'registration' | 'password-reset';
export interface PendingChallenge {
  challengeId: string;
  email: string;
  purpose: ChallengePurpose;
  expiresAt: number;
  resendAt: number;
}

const key = (purpose: ChallengePurpose) => `docflow.challenge.${purpose}`;
const memory = new Map<ChallengePurpose, PendingChallenge>();

export function pendingChallenge(response: ChallengeResponse, purpose: ChallengePurpose, now = Date.now()): PendingChallenge {
  return { challengeId: response.challengeId, email: response.email, purpose, expiresAt: now + response.expiresIn * 1000, resendAt: now + response.resendAfter * 1000 };
}

/** Persist only nonsecret coordinates. Passwords, codes and tokens never enter browser storage. */
export function saveChallenge(challenge: PendingChallenge): void {
  const safe = { challengeId: challenge.challengeId, email: challenge.email, purpose: challenge.purpose, expiresAt: challenge.expiresAt, resendAt: challenge.resendAt };
  memory.set(safe.purpose, safe);
  try { sessionStorage.setItem(key(safe.purpose), JSON.stringify(safe)); } catch { /* Allow the current flow when browser storage is unavailable. */ }
}

export function readChallenge(purpose: ChallengePurpose): PendingChallenge | null {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key(purpose)) || 'null');
    if (raw && typeof raw === 'object' && 'challengeId' in raw && 'email' in raw && 'purpose' in raw && 'expiresAt' in raw && 'resendAt' in raw &&
      typeof raw.challengeId === 'string' && raw.challengeId.length > 0 && typeof raw.email === 'string' && raw.purpose === purpose &&
      typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) && typeof raw.resendAt === 'number' && Number.isFinite(raw.resendAt)) {
      return { challengeId: raw.challengeId, email: raw.email, purpose, expiresAt: raw.expiresAt, resendAt: raw.resendAt };
    }
  } catch { return memory.get(purpose) ?? null; }
  return memory.get(purpose) ?? null;
}

export function clearChallenge(purpose: ChallengePurpose): void {
  memory.delete(purpose);
  try { sessionStorage.removeItem(key(purpose)); } catch { /* There is no persistent copy to clear. */ }
}
