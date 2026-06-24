/** Bot scope config, read from the environment (Bun auto-loads .env). */

export type DmMode = "anyone" | "self" | "off";
export type GroupMode = "mention" | "all" | "off";

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = value?.trim().toLowerCase() ?? "";
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export const config = {
  /** Who may trigger downloads in direct chats. */
  dms: oneOf(process.env.PING_DMS, ["anyone", "self", "off"] as const, "anyone"),
  /** How the bot behaves in group chats. */
  groups: oneOf(process.env.PING_GROUPS, ["mention", "all", "off"] as const, "mention"),
};
