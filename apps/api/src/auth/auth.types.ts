import { Request } from 'express';
import { PrivacyLevel } from '@prisma/client';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  timezone: string;
  privacyLevel: PrivacyLevel;
}

export const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  timezone: true,
  privacyLevel: true,
} as const;

export interface AccessClaims {
  sub: string;
  sid: string;
}

export interface AuthRequest extends Request {
  auth?: { user: PublicUser; sessionId: string };
}

export interface AuthResponse {
  accessToken: string;
  expiresIn: 900;
  user: PublicUser;
}

export interface IssuedAuth {
  body: AuthResponse;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface ChallengeResponse {
  challengeId: string;
  email: string;
  expiresIn: 600;
  resendAfter: 60;
  message: string;
}

export const ACCESS_TTL_SECONDS = 900;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_COOKIE = 'docflow_refresh';
export const TOKEN_ISSUER = 'docflow-api';
export const TOKEN_AUDIENCE = 'docflow-web';
