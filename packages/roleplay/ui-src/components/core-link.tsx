import type { ReactNode } from "react";
import { getPluginBridge } from "@rp/bridge";

export function CoreLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void getPluginBridge().ui.navigate(to);
      }}
    >
      {children}
    </button>
  );
}
