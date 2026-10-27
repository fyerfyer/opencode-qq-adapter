import {
  Activity,
  Blocks,
  Bot,
  ChevronDown,
  Clapperboard,
  FolderGit2,
  Gauge,
  LogOut,
  MessagesSquare,
  Moon,
  Puzzle,
  ScrollText,
  Settings,
  Sun,
  UsersRound,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import type { MetaInfo, Overview } from "@/api/types";
import { useAuth } from "@/auth/auth-provider";
import { StatusDot } from "@/components/common/status-dot";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useApiQuery } from "@/hooks/use-api-query";
import { cn } from "@/lib/utils";

const navigation = [
  {
    label: "工作台",
    items: [
      { to: "/", label: "概览", icon: Gauge, end: true },
      { to: "/sessions", label: "会话", icon: MessagesSquare },
      { to: "/projects", label: "项目", icon: FolderGit2 },
    ],
  },
  {
    label: "访问",
    items: [{ to: "/access", label: "成员", icon: UsersRound }],
  },
  {
    label: "运维",
    items: [
      { to: "/audit", label: "审计", icon: ScrollText },
      { to: "/usage", label: "用量", icon: Activity },
      { to: "/agents", label: "Agents", icon: Bot },
      { to: "/plugins", label: "插件", icon: Blocks },
      { to: "/settings", label: "设置", icon: Settings },
    ],
  },
];

const titles: Record<string, string> = {
  "/": "概览",
  "/sessions": "会话",
  "/projects": "项目",
  "/access": "成员",
  "/agents": "Agents",
  "/audit": "审计",
  "/usage": "用量",
  "/plugins": "插件",
  "/roleplay": "Roleplay",
  "/settings": "设置",
};

export function AppShell() {
  const { session, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const overview = useApiQuery<Overview>("/overview", { intervalMs: 30_000 });
  const meta = useApiQuery<MetaInfo>("/meta", { intervalMs: 60_000 });
  const status = overview.data?.status;
  const pluginPages =
    meta.data?.plugins.plugins.flatMap((plugin) =>
      plugin.status === "loaded" ? plugin.admin.pages.map((page) => ({ plugin, page })) : [],
    ) ?? [];
  const pluginPageTitle = pluginPages.find(
    ({ plugin, page }) =>
      page.path === location.pathname ||
      location.pathname === `/plugins/${plugin.id}` ||
      (page.kind === "iframe" && location.pathname.startsWith(`/plugins/${plugin.id}/${page.id}`)),
  )?.page.title;

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild tooltip="OpenCode QQ">
                <Link to="/">
                  <div className="flex size-8 items-center justify-center rounded-lg border bg-foreground text-sm font-bold text-background">
                    Q
                  </div>
                  <div className="grid min-w-0 leading-tight">
                    <span className="truncate font-semibold">OpenCode QQ</span>
                    <span className="truncate text-xs text-muted-foreground">Admin console</span>
                  </div>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {navigation.map((section) => (
            <SidebarGroup key={section.label}>
              <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {section.items.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={
                          item.end
                            ? location.pathname === item.to
                            : location.pathname.startsWith(item.to)
                        }
                        tooltip={item.label}
                      >
                        <NavLink to={item.to} end={item.end}>
                          <item.icon />
                          <span>{item.label}</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
          {pluginPages.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel>插件</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {pluginPages.map(({ plugin, page }) => {
                    const to =
                      page.path ??
                      `/plugins/${encodeURIComponent(plugin.id)}/${encodeURIComponent(page.id)}`;
                    const Icon = plugin.id === "roleplay" ? Clapperboard : Puzzle;
                    return (
                      <SidebarMenuItem key={`${plugin.id}:${page.id}`}>
                        <SidebarMenuButton
                          asChild
                          isActive={
                            location.pathname === to ||
                            location.pathname.startsWith(`${to}/`) ||
                            (page.kind === "iframe" &&
                              location.pathname === `/plugins/${plugin.id}`)
                          }
                          tooltip={page.title}
                        >
                          <NavLink to={to}>
                            <Icon />
                            <span>{page.title}</span>
                          </NavLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>
        <SidebarFooter>
          <div className="flex items-center gap-2 rounded-lg border bg-background/50 p-2 group-data-[collapsible=icon]:hidden">
            <StatusDot
              tone={status?.status === "ok" ? "ok" : status?.status === "error" ? "error" : "warn"}
              pulse={status?.status === "ok"}
            />
            <div className="grid min-w-0 leading-tight">
              <span className="text-xs font-medium">
                {status === undefined
                  ? "状态未知"
                  : status.status === "ok"
                    ? "运行正常"
                    : status.status === "error"
                      ? "服务异常"
                      : "部分降级"}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {status === undefined
                  ? "等待 bridge 响应"
                  : `OneBot ${status.onebot.connected ? "已连接" : "未连接"} · OpenCode ${status.opencode.healthy ? "正常" : "不可用"}`}
              </span>
            </div>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton size="lg" tooltip={session?.username ?? "admin"}>
                    <Avatar className="size-8 rounded-lg">
                      <AvatarFallback className="rounded-lg bg-muted text-xs font-semibold">
                        {session?.username.slice(0, 1).toUpperCase() ?? "A"}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left leading-tight">
                      <span className="truncate text-sm font-medium">
                        {session?.username ?? "admin"}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">本地管理员</span>
                    </div>
                    <ChevronDown className="ml-auto size-4" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end" className="w-56">
                  <DropdownMenuLabel>管理员</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate("/settings")}>
                    <Settings /> 设置
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      void logout();
                    }}
                  >
                    <LogOut /> 退出登录
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur-xl">
          <SidebarTrigger className="md:hidden" />
          <SidebarTrigger className="hidden md:inline-flex" />
          <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
          <span className="text-sm font-medium">
            {pluginPageTitle ?? titles[location.pathname] ?? "Admin"}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <StatusPill label="OneBot" online={status?.onebot.connected ?? false} />
            <StatusPill label="OpenCode" online={status?.opencode.healthy ?? false} />
            <ThemeToggle />
          </div>
        </header>
        {session?.mustChangePassword === true && (
          <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
            当前仍在使用初始密码。请前往{" "}
            <Link to="/settings" className="font-medium underline underline-offset-2">
              设置 → 安全
            </Link>{" "}
            修改密码。
          </div>
        )}
        <main className="flex min-w-0 flex-1 flex-col gap-6 p-4 md:p-6 lg:p-8">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function StatusPill({ label, online }: { label: string; online: boolean }) {
  return (
    <span
      className={cn(
        "hidden items-center gap-1.5 rounded-full border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground sm:inline-flex",
      )}
    >
      <StatusDot tone={online ? "ok" : "warn"} />
      {label}
    </span>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="切换主题"
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
