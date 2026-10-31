export interface AdminUserRecord {
  username: string;
  passwordHash: string;
  mustChangePassword: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AdminSessionRecord {
  tokenHash: string;
  username: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  userAgent: string | null;
  ip: string | null;
}

export interface AdminSessionInput {
  tokenHash: string;
  username: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
  userAgent: string | null;
  ip: string | null;
}
