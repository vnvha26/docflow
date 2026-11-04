import { useSyncExternalStore } from 'react';
import { authClient } from './api';

export function useSession() { return useSyncExternalStore(authClient.subscribe, authClient.getSnapshot); }
