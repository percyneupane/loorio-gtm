import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { deleteKv, getKv, setKv } from '../repo/state.ts';

/**
 * Google OAuth for one Gmail account. The refresh token lives in the local SQLite database
 * (data/, git-ignored). The callback path matches the redirect URI already registered on the
 * outreach-tracker OAuth client, so the same client ID works without changes.
 */

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];
export const CALLBACK_PATH = '/api/auth/callback/google';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_KEY = 'google_refresh_token';
const ACCOUNT_KEY = 'gmail_address';
const EXPIRY_MARGIN_MS = 60_000;

export interface GoogleAuth {
  authUrl(state: string): string;
  exchangeCode(code: string): Promise<void>;
  accessToken(): Promise<string>;
  isConnected(): boolean;
  account(): string | undefined;
  setAccount(email: string): void;
  disconnect(): void;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as TokenResponse;
  if (!res.ok || body.error) {
    throw new Error(`Google token error: ${body.error ?? res.status} ${body.error_description ?? ''}`.trim());
  }
  return body;
}

export function createGoogleAuth(db: Db, config: Config): GoogleAuth {
  const redirectUri = new URL(CALLBACK_PATH, config.APP_URL).toString();
  let cached: { token: string; expiresAt: number } | undefined;

  return {
    authUrl(state) {
      const params = new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    },

    async exchangeCode(code) {
      const tokens = await postToken({
        code,
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      if (!tokens.refresh_token) {
        throw new Error('Google did not return a refresh token — remove the app at myaccount.google.com/permissions and connect again');
      }
      setKv(db, REFRESH_KEY, tokens.refresh_token);
      if (tokens.access_token && tokens.expires_in) {
        cached = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
      }
    },

    async accessToken() {
      if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached.token;
      const refreshToken = getKv(db, REFRESH_KEY);
      if (!refreshToken) throw new Error('Gmail is not connected — open the dashboard and click "Connect Gmail"');
      const tokens = await postToken({
        refresh_token: refreshToken,
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
      });
      if (!tokens.access_token) throw new Error('Google refresh returned no access token');
      cached = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 };
      return cached.token;
    },

    isConnected: () => getKv(db, REFRESH_KEY) !== undefined,
    account: () => getKv(db, ACCOUNT_KEY),
    setAccount: (email) => setKv(db, ACCOUNT_KEY, email.toLowerCase()),
    disconnect() {
      cached = undefined;
      deleteKv(db, REFRESH_KEY);
      deleteKv(db, ACCOUNT_KEY);
    },
  };
}
