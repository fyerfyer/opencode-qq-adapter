import type {
  PluginAdminRequestContext,
  PluginAdminResult,
} from "@opencode-qq/plugin-sdk";

export class AdminHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AdminHttpError";
    this.status = status;
    this.code = code;
  }
}

export type AdminHandler = (context: PluginAdminRequestContext) => Promise<unknown> | unknown;
export type AdminRoute = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  handler: AdminHandler,
) => void;

export function param(context: PluginAdminRequestContext, name: string): string {
  const value = context.params[name];
  if (value === undefined) {
    throw new AdminHttpError(400, "missing_param", `缺少路径参数：${name}`);
  }
  return value;
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = (await request.json()) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AdminHttpError(400, "invalid_json", "请求体必须是 JSON 对象。");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AdminHttpError) throw error;
    throw new AdminHttpError(400, "invalid_json", "请求体必须是 JSON 对象。");
  }
}

export async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new AdminHttpError(400, "invalid_form", "请求体必须是 multipart/form-data。");
  }
}

export async function withAdminErrors(
  task: () => Promise<unknown> | unknown,
): Promise<PluginAdminResult> {
  try {
    return (await task()) as PluginAdminResult;
  } catch (error) {
    if (error instanceof AdminHttpError) {
      return new Response(JSON.stringify({ error: error.code, message: error.message }), {
        status: error.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    throw error;
  }
}
