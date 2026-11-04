import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { readChallenge } from '../../lib/challenge';
import { CodeChallenge } from './CodeChallenge';

export function VerifyEmailPage() {
  const [challenge, setChallenge] = useState(() => readChallenge('registration'));
  if (!challenge) return <Navigate to="/register" replace />;
  return <CodeChallenge challenge={challenge} onChallenge={setChallenge} />;
}
