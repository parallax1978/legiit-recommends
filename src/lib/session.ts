import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createClient } from "./supabase/server";

export type Role = "owner" | "admin" | "member";

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
  emergencyStop: boolean;
  emergencyStopReason: string | null;
  retentionDays: number | null;
}

export interface Session {
  userId: string;
  email: string;
  displayName: string | null;
  workspaces: WorkspaceSummary[];
  /** The workspace the user is currently working in. */
  workspace: WorkspaceSummary;
  role: Role;
}

export const WORKSPACE_COOKIE = "lr_workspace";

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/** owner > admin > member */
export function hasRole(role: Role, minimum: Role): boolean {
  const rank: Record<Role, number> = { member: 1, admin: 2, owner: 3 };
  return rank[role] >= rank[minimum];
}

interface Identity {
  userId: string;
  email: string;
  /** How this session was established ("password", "recovery", "invite", "otp", …). */
  methods: string[];
}

/** True for a session that began with a password, as opposed to a one-time email link. */
export function signedInWithPassword(identity: Identity): boolean {
  return identity.methods.includes("password");
}

/** The verified identity of the caller, or null. Deduplicated per request. */
export const getIdentity = cache(async (): Promise<Identity | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  const amr: unknown = (claims as { amr?: unknown }).amr;
  const methods = Array.isArray(amr)
    ? amr.map((entry) =>
        typeof entry === "string" ? entry : String((entry as { method?: unknown })?.method ?? ""),
      )
    : [];
  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : "",
    methods,
  };
});

/**
 * The signed-in user with their workspaces, or null when not signed in or not a member of any
 * workspace. The current workspace comes from a cookie but is always validated against the
 * user's real memberships: a forged cookie cannot select a workspace the user is not in.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const identity = await getIdentity();
  if (!identity) return null;
  const supabase = await createClient();

  const [{ data: memberships, error: membershipsError }, { data: profile }] = await Promise.all([
    supabase
      .from("workspace_members")
      .select(
        "role, created_at, workspaces(id, name, emergency_stop, emergency_stop_reason, retention_days)",
      )
      .eq("user_id", identity.userId)
      .order("created_at", { ascending: true }),
    supabase.from("profiles").select("display_name").eq("id", identity.userId).maybeSingle(),
  ]);
  // A list that could not be read is not an empty list. Treating it as one would send a member
  // to the "you have no workspace" screen whenever the database is briefly unreachable.
  if (membershipsError) {
    console.error("memberships_unreadable", membershipsError.code, membershipsError.message);
    throw new Error("Your workspaces could not be loaded.");
  }

  const workspaces: WorkspaceSummary[] = [];
  for (const membership of memberships ?? []) {
    const workspace = membership.workspaces;
    if (!workspace) continue;
    workspaces.push({
      id: workspace.id,
      name: workspace.name,
      role: membership.role,
      emergencyStop: workspace.emergency_stop,
      emergencyStopReason: workspace.emergency_stop_reason,
      retentionDays: workspace.retention_days,
    });
  }
  if (workspaces.length === 0) return null;

  const selected = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const workspace = workspaces.find((candidate) => candidate.id === selected) ?? workspaces[0]!;
  return {
    userId: identity.userId,
    email: identity.email,
    displayName: profile?.display_name ?? null,
    workspaces,
    workspace,
    role: workspace.role,
  };
});

/** For pages inside the app: redirects when there is no session or no workspace. */
export async function requireSession(): Promise<Session> {
  const identity = await getIdentity();
  if (!identity) redirect("/sign-in");
  const session = await getSession();
  if (!session) redirect("/setup");
  return session;
}

/** For server actions: the session, or null (the action then reports "not signed in"). */
export async function actionSession(): Promise<Session | null> {
  return getSession();
}
