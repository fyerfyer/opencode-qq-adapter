import { ADMIN_USERNAME } from "../admin/auth.js";
import { generatePassword, hashPassword } from "../admin/password.js";
import { SetupError } from "./files.js";
import type { Prompt } from "./prompt.js";

export type AdminPasswordAction = "generated" | "provided" | "updated" | "unchanged";

export interface AdminPasswordPlan {
  action: AdminPasswordAction;
  /** Password to show in the setup summary, or null when the existing one was kept. */
  password: string | null;
  /** Bootstrap password for `.env`; only new databases need one. */
  envPassword: string | null;
}

/**
 * Resolve the admin password for both first-run and re-setup flows.
 *
 * A new database can use `--admin-password`, an interactive password, or a
 * generated one. An existing database is never changed silently: setup asks
 * whether to keep or reset it, and an explicit `--admin-password` means reset.
 */
export async function resolveAdminPassword(options: {
  databasePath: string;
  databaseExists: boolean;
  initialPassword?: string;
  prompt: Prompt | null;
  output: (line: string) => void;
}): Promise<AdminPasswordPlan> {
  const explicit = options.initialPassword?.trim();
  if (explicit !== undefined) validatePassword(explicit);

  if (!options.databaseExists) {
    const chosen =
      explicit !== undefined
        ? explicit
        : options.prompt === null
          ? null
          : await askNewPassword(options.prompt, options.output);
    if (chosen === null) {
      const generated = generatePassword();
      return { action: "generated", password: generated, envPassword: generated };
    }
    return { action: "provided", password: chosen, envPassword: chosen };
  }

  let update = explicit !== undefined;
  let chosen = explicit ?? null;
  if (!update && options.prompt !== null) {
    const action = await options.prompt.select(
      "Admin password (existing account found):",
      [
        { value: "reset", label: "Reset and show a new admin password (recommended)" },
        { value: "keep", label: "Keep the existing admin password (I know it)" },
      ],
      0,
    );
    if (action === "reset") {
      update = true;
      chosen = await askNewPassword(options.prompt, options.output);
    }
  }
  if (!update) return { action: "unchanged", password: null, envPassword: null };

  const final = chosen ?? generatePassword();
  await applyAdminPassword(options.databasePath, final);
  return { action: "updated", password: final, envPassword: null };
}

function validatePassword(password: string): void {
  if (password.length < 10) {
    throw new SetupError("invalid", "Admin password must be at least 10 characters.");
  }
  if (/[\r\n\0]/.test(password)) {
    throw new SetupError("invalid", "Admin password cannot contain line breaks or NUL bytes.");
  }
}

async function askNewPassword(
  prompt: Prompt,
  output: (line: string) => void,
): Promise<string | null> {
  for (;;) {
    const password = (await prompt.password("Admin password (leave empty to generate)")).trim();
    if (password.length === 0) return null;
    if (password.length < 10) {
      output("      Admin password must be at least 10 characters.");
      continue;
    }
    const confirmation = (await prompt.password("Confirm admin password")).trim();
    if (confirmation !== password) {
      output("      Passwords do not match. Try again.");
      continue;
    }
    return password;
  }
}

async function applyAdminPassword(path: string, password: string): Promise<void> {
  const { SqliteStore } = await import("../store/sqlite.js");
  let store: InstanceType<typeof SqliteStore> | null = null;
  try {
    store = new SqliteStore(path);
    const now = Date.now();
    const passwordHash = await hashPassword(password);
    const existing = store.admin.getUser(ADMIN_USERNAME);
    if (existing === null) {
      store.admin.createUser({
        username: ADMIN_USERNAME,
        passwordHash,
        mustChangePassword: true,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      store.admin.updatePassword(ADMIN_USERNAME, passwordHash, true, now);
    }
    store.admin.deleteSessions();
  } catch (error) {
    throw new SetupError(
      "invalid",
      `Could not update the admin password: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    store?.close();
  }
}
