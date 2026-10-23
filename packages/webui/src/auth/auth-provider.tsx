import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api, type SessionInfo, setCsrfToken } from "@/api/client";

interface AuthContextValue {
  status: "loading" | "anonymous" | "authenticated";
  session: SessionInfo | null;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setMustChangePassword: (value: boolean) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthContextValue["status"]>("loading");
  const [session, setSession] = useState<SessionInfo | null>(null);

  const clear = useCallback(() => {
    setCsrfToken(null);
    setSession(null);
    setStatus("anonymous");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.session();
      setCsrfToken(next.csrfToken);
      setSession(next);
      setStatus("authenticated");
    } catch {
      clear();
    }
  }, [clear]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onUnauthorized = () => clear();
    window.addEventListener("admin:unauthorized", onUnauthorized);
    return () => window.removeEventListener("admin:unauthorized", onUnauthorized);
  }, [clear]);

  const login = useCallback(async (password: string) => {
    const next = await api.login(password);
    setCsrfToken(next.csrfToken);
    setSession(next);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      clear();
    }
  }, [clear]);

  const setMustChangePassword = useCallback((value: boolean) => {
    setSession((current) => (current === null ? null : { ...current, mustChangePassword: value }));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, session, login, logout, refresh, setMustChangePassword }),
    [status, session, login, logout, refresh, setMustChangePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
