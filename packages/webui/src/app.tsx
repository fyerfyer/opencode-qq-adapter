import { LoaderCircle } from "lucide-react";
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "@/auth/auth-provider";
import { AppShell } from "@/components/layout/app-shell";
import { Toaster } from "@/components/ui/sonner";
import { AccessPage } from "@/pages/access";
import { AgentsPage } from "@/pages/agents";
import { AuditPage } from "@/pages/audit";
import { DashboardPage } from "@/pages/dashboard";
import { LoginPage } from "@/pages/login";
import { PluginsPage } from "@/pages/plugins";
import { PoliciesPage } from "@/pages/policies";
import { ProjectsPage } from "@/pages/projects";
import { SessionsPage } from "@/pages/sessions";
import { SettingsPage } from "@/pages/settings";
import { UsagePage } from "@/pages/usage";

const RoleplayPage = lazy(() =>
  import("@/pages/roleplay").then((module) => ({ default: module.RoleplayPage })),
);

export function App() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background">
        <div className="flex size-12 items-center justify-center rounded-xl border bg-foreground text-lg font-bold text-background">
          Q
        </div>
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" /> 正在验证管理员会话…
        </p>
      </div>
    );
  }

  if (status === "anonymous") {
    return (
      <>
        <LoginPage />
        <Toaster position="bottom-right" richColors closeButton />
      </>
    );
  }

  return (
    <>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="access" element={<AccessPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="policies" element={<PoliciesPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="prompts" element={<Navigate to="/agents" replace />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="plugins" element={<PluginsPage />} />
          <Route
            path="roleplay"
            element={
              <Suspense
                fallback={
                  <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" /> 正在加载 Roleplay…
                  </div>
                }
              >
                <RoleplayPage />
              </Suspense>
            }
          />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toaster position="bottom-right" richColors closeButton />
    </>
  );
}
