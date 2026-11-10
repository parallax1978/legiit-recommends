import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { RetryJobButton } from "@/components/operations-buttons";
import {
  AddPriceButton,
  ArchiveConnectionButton,
  CredentialButton,
  DATA_CONTROLS_URL,
  DataSharingButton,
  EditConnectionButton,
  NewConnectionButton,
  TestConnectionButton,
  VerifyModelForm,
} from "@/components/settings/connection-panels";
import {
  DeleteWorkspaceForm,
  EmergencyStopControl,
  InviteForm,
  MemberRowActions,
  ProfileForm,
  RevokeInvitationButton,
  RoleBadge,
  WorkspaceForm,
} from "@/components/settings/workspace-panels";
import { ConnectionStatusBadge, JobStatusBadge } from "@/components/status";
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
} from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { DefinitionList, PermissionNote, Screen, Tabs } from "@/components/ui/misc";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatNumber, formatUsd } from "@/lib/format";
import { dataSharing, errorClass, humanize, jobKind, pauseReason, reasonText } from "@/lib/labels";
import { first, type SearchParams } from "@/lib/params";
import type { OperationalStatus } from "@/lib/queries/types";
import { hasRole, requireSession, type Session } from "@/lib/session";
import { createClient, type ServerClient } from "@/lib/supabase/server";
import type { CapabilityProfile } from "@shared/core/capabilities.ts";

export const metadata: Metadata = { title: "Settings" };

const TABS = [
  { id: "workspace", label: "Workspace" },
  { id: "members", label: "Members" },
  { id: "connections", label: "OpenAI connections" },
  { id: "pricing", label: "Model pricing" },
  { id: "status", label: "Operational status" },
  { id: "profile", label: "Your account" },
];

export default function SettingsPage(props: PageProps<"/settings">) {
  return (
    <Screen>
      <Settings searchParams={props.searchParams} />
    </Screen>
  );
}

async function Settings({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireSession();
  const params = await searchParams;
  const requested = first(params.tab);
  const tab = TABS.some((item) => item.id === requested) ? requested : "workspace";
  const supabase = await createClient();

  return (
    <>
      <PageHeader
        title="Settings"
        description={`${session.workspace.name} · you are ${session.role === "owner" ? "an owner" : session.role === "admin" ? "an admin" : "a member"}`}
      />
      <Tabs
        label="Settings sections"
        active={tab}
        tabs={TABS.map((item) => ({ ...item, href: `/settings?tab=${item.id}` }))}
      />
      {tab === "workspace" ? <WorkspaceTab session={session} /> : null}
      {tab === "members" ? <MembersTab session={session} supabase={supabase} /> : null}
      {tab === "connections" ? <ConnectionsTab session={session} supabase={supabase} /> : null}
      {tab === "pricing" ? <PricingTab session={session} supabase={supabase} /> : null}
      {tab === "status" ? <StatusTab session={session} supabase={supabase} /> : null}
      {tab === "profile" ? <ProfileTab session={session} /> : null}
    </>
  );
}

function ProfileTab({ session }: { session: Session }) {
  return (
    <Card>
      <CardHeader title="Your account" description="Shown to other members of your workspaces." />
      <CardBody>
        <ProfileForm displayName={session.displayName ?? ""} email={session.email} />
        <p className="text-ink-muted mt-6 text-[13px]">
          To change your password, sign out and use{" "}
          <Link href="/forgot-password" className="text-brand hover:text-brand-strong font-medium">
            Forgot your password
          </Link>
          .
        </p>
      </CardBody>
    </Card>
  );
}

function WorkspaceTab({ session }: { session: Session }) {
  const owner = hasRole(session.role, "owner");
  const workspace = session.workspace;
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="Workspace"
          description="Campaigns, prompts, connections and members belong to a workspace."
        />
        <CardBody>
          {owner ? (
            <WorkspaceForm
              workspaceId={workspace.id}
              name={workspace.name}
              retentionDays={workspace.retentionDays}
            />
          ) : (
            <>
              <DefinitionList
                items={[
                  { term: "Name", value: workspace.name },
                  {
                    term: "Transcript retention",
                    value: workspace.retentionDays
                      ? `${workspace.retentionDays} days`
                      : "Kept until deleted",
                  },
                ]}
              />
              <div className="mt-4">
                <PermissionNote>Only owners can change workspace settings.</PermissionNote>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Emergency stop"
          description="One switch for all spending in this workspace."
        />
        <CardBody>
          {owner ? (
            <EmergencyStopControl
              workspaceId={workspace.id}
              enabled={workspace.emergencyStop}
              reason={workspace.emergencyStopReason}
            />
          ) : (
            <PermissionNote>
              {workspace.emergencyStop
                ? "The emergency stop is on. No provider requests are being sent."
                : "The emergency stop is off."}{" "}
              Only owners can change it.
            </PermissionNote>
          )}
        </CardBody>
      </Card>

      {owner ? (
        <Card>
          <CardHeader
            title="Delete workspace"
            description="Permanently removes all of its data, including stored API keys."
          />
          <CardBody>
            <p className="text-ink-muted mb-4 max-w-xl text-[13px]">
              Export anything you need first: results and usage as CSV, transcripts and
              configurations as JSON, from each campaign. Campaigns must be finished, canceled or
              paused with no requests in flight.
            </p>
            <DeleteWorkspaceForm workspaceId={workspace.id} name={workspace.name} />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

async function MembersTab({ session, supabase }: { session: Session; supabase: ServerClient }) {
  const owner = hasRole(session.role, "owner");
  const workspaceId = session.workspace.id;
  const { data: members } = await supabase
    .from("workspace_members")
    .select("user_id, role, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at");
  const ids = (members ?? []).map((member) => member.user_id);
  const [{ data: profiles }, invitations] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, email, display_name")
      .in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]),
    owner
      ? supabase
          .from("workspace_invitations")
          .select("id, email, role, created_at, expires_at")
          .eq("workspace_id", workspaceId)
          .eq("status", "pending")
          .order("created_at", { ascending: false })
      : Promise.resolve({
          data: [] as {
            id: string;
            email: string;
            role: "owner" | "admin" | "member";
            created_at: string;
            expires_at: string;
          }[],
        }),
  ]);
  const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));

  return (
    <div className="flex flex-col gap-6">
      {owner ? (
        <Card>
          <CardHeader
            title="Invite a person"
            description="Access is by invitation only. The person receives an email with a link to set a password."
          />
          <CardBody>
            <InviteForm workspaceId={workspaceId} />
            <ul className="text-ink-muted mt-4 grid grid-cols-1 gap-1 text-xs sm:grid-cols-3">
              <li>
                <span className="text-ink font-semibold">Members</span> inspect campaigns,
                transcripts and results, and export data.
              </li>
              <li>
                <span className="text-ink font-semibold">Admins</span> also create, launch, pause
                and edit campaigns and prompts.
              </li>
              <li>
                <span className="text-ink font-semibold">Owners</span> also manage credentials,
                spending limits, members and deletion.
              </li>
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <TableWrap label="Workspace members">
        <Table>
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Role</Th>
              <Th>Member since</Th>
              {owner ? <Th className="text-right">Manage</Th> : null}
            </tr>
          </thead>
          <tbody>
            {(members ?? []).map((member) => {
              const profile = profileById.get(member.user_id);
              const label = profile?.display_name || profile?.email || "Member";
              return (
                <Tr key={member.user_id}>
                  <Td>
                    <span className="font-medium">{label}</span>
                    {member.user_id === session.userId ? (
                      <span className="text-ink-muted"> (you)</span>
                    ) : null}
                    {profile?.display_name ? (
                      <div className="text-ink-muted text-xs">{profile.email}</div>
                    ) : null}
                  </Td>
                  <Td>
                    <RoleBadge role={member.role} />
                  </Td>
                  <Td>
                    <LocalTime value={member.created_at} dateOnly />
                  </Td>
                  {owner ? (
                    <Td>
                      <MemberRowActions
                        workspaceId={workspaceId}
                        userId={member.user_id}
                        role={member.role}
                        isSelf={member.user_id === session.userId}
                        label={label}
                      />
                    </Td>
                  ) : null}
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableWrap>
      {!owner ? (
        <PermissionNote>
          Only owners can invite people, change roles or remove members.
        </PermissionNote>
      ) : null}

      {owner ? (
        <div>
          <h2 className="text-ink mb-3 text-[15px] font-semibold">Pending invitations</h2>
          {(invitations.data ?? []).length === 0 ? (
            <p className="text-ink-muted text-[13px]">No invitations are waiting to be accepted.</p>
          ) : (
            <TableWrap label="Pending invitations">
              <Table>
                <thead>
                  <tr>
                    <Th>Email</Th>
                    <Th>Role</Th>
                    <Th>Sent</Th>
                    <Th>Expires</Th>
                    <Th className="text-right">Manage</Th>
                  </tr>
                </thead>
                <tbody>
                  {(invitations.data ?? []).map((invitation) => (
                    <Tr key={invitation.id}>
                      <Td className="font-medium">{invitation.email}</Td>
                      <Td>
                        <RoleBadge role={invitation.role} />
                      </Td>
                      <Td>
                        <LocalTime value={invitation.created_at} dateOnly />
                      </Td>
                      <Td>
                        <LocalTime value={invitation.expires_at} dateOnly />
                      </Td>
                      <Td className="text-right">
                        <RevokeInvitationButton
                          invitationId={invitation.id}
                          email={invitation.email}
                        />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </div>
      ) : null}
    </div>
  );
}

function capabilityRows(profile: CapabilityProfile) {
  const sampling = (support: string) =>
    support === "always"
      ? "Accepted"
      : support === "effort_none"
        ? 'Accepted only with reasoning effort "none"'
        : "Not accepted";
  return [
    {
      term: "Multi-turn conversations",
      value: profile.chaining
        ? "Supported (stored responses, continued by response ID)"
        : "Not supported — this model cannot run conversation campaigns",
    },
    {
      term: "Reasoning effort",
      value: profile.reasoning_efforts.length
        ? `${profile.reasoning_efforts.join(", ")}${profile.default_reasoning_effort ? ` · default ${profile.default_reasoning_effort}` : ""}`
        : "Not accepted",
    },
    { term: "Temperature", value: sampling(profile.temperature) },
    { term: "Top-p", value: sampling(profile.top_p) },
    {
      term: "Verbosity",
      value: profile.verbosity.length ? profile.verbosity.join(", ") : "Not accepted",
    },
    {
      term: "Output cap",
      value: `Verified up to ${formatNumber(profile.max_output_tokens_verified)} tokens${profile.max_output_tokens_limit ? ` · provider limit ${formatNumber(profile.max_output_tokens_limit)}` : ""}`,
    },
    { term: "Background responses", value: profile.background ? "Supported" : "Not supported" },
    { term: "Model ID returned", value: profile.returned_model ?? "—" },
  ];
}

async function ConnectionsTab({ session, supabase }: { session: Session; supabase: ServerClient }) {
  const owner = hasRole(session.role, "owner");
  const workspaceId = session.workspace.id;
  const { data: connections } = await supabase
    .from("provider_connections")
    .select("*")
    .eq("workspace_id", workspaceId)
    .is("archived_at", null)
    .order("created_at");
  const ids = (connections ?? []).map((connection) => connection.id);
  const [{ data: models }, { data: prices }] = await Promise.all([
    ids.length
      ? supabase
          .from("provider_models")
          .select(
            "connection_id, model_id, is_listed, shutdown_date, verification_status, verified_at, capabilities, verification_error",
          )
          .in("connection_id", ids)
          .order("model_id")
      : Promise.resolve({ data: [] as never[] }),
    supabase.rpc("effective_prices", { p_workspace_id: workspaceId }),
  ]);
  const priced = new Set((prices ?? []).map((price) => price.model_id));

  if ((connections ?? []).length === 0) {
    return (
      <EmptyState
        title="No OpenAI connection yet"
        description={
          owner
            ? "A connection holds an API key, its spending limits and the models you have verified. Campaigns cannot run without one."
            : "An owner needs to add an OpenAI connection before campaigns can run."
        }
        action={owner ? <NewConnectionButton workspaceId={workspaceId} primary /> : null}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {owner ? (
        <div className="flex justify-end">
          <NewConnectionButton workspaceId={workspaceId} />
        </div>
      ) : (
        <PermissionNote>
          Only owners can manage credentials, limits and model verification. Keys are never shown to
          anyone.
        </PermissionNote>
      )}

      {(connections ?? []).map((connection) => {
        const own = (models ?? []).filter((model) => model.connection_id === connection.id);
        const verified = own.filter((model) => model.verification_status === "verified");
        const failed = own.filter((model) => model.verification_status === "failed");
        const listed = own.filter((model) => model.is_listed);
        const sharing = dataSharing(connection.data_sharing);
        return (
          <Card key={connection.id}>
            <CardHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {connection.name}
                  <ConnectionStatusBadge status={connection.status} />
                </span>
              }
              description={
                connection.key_hint ? (
                  <>
                    Key <span className="font-mono text-xs">{connection.key_hint}</span> · stored{" "}
                    <LocalTime value={connection.key_set_at} dateOnly />
                    {connection.last_ok_at ? (
                      <>
                        {" "}
                        · last successful check <LocalTime value={connection.last_ok_at} />
                      </>
                    ) : null}
                  </>
                ) : (
                  "No API key stored."
                )
              }
              action={
                owner ? (
                  <>
                    {connection.key_hint ? (
                      <TestConnectionButton connectionId={connection.id} />
                    ) : null}
                    <CredentialButton
                      connectionId={connection.id}
                      hasKey={Boolean(connection.key_hint)}
                    />
                  </>
                ) : null
              }
            />
            <CardBody className="flex flex-col gap-6">
              {connection.status === "error" ? (
                <Callout
                  tone="bad"
                  role="alert"
                  title="The last request with this connection failed"
                >
                  {connection.status_message ??
                    errorClass(connection.status_code) ??
                    "Unknown error."}{" "}
                  Work that uses this connection is on hold. Fix the cause, then use “Test
                  connection”: a successful test releases the held work.
                </Callout>
              ) : null}

              <section aria-label="Limits">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-ink text-[13px] font-semibold">Limits</h3>
                  {owner ? (
                    <div className="flex gap-2">
                      <EditConnectionButton
                        connectionId={connection.id}
                        limits={{
                          name: connection.name,
                          dailyBudget: connection.daily_budget_usd,
                          totalBudget: connection.total_budget_usd,
                          maxConcurrent: connection.max_concurrent_requests,
                          rpm: connection.requests_per_minute,
                          tpm: connection.tokens_per_minute,
                          storeFreshChecks: connection.store_fresh_check_responses,
                        }}
                      />
                      <ArchiveConnectionButton
                        connectionId={connection.id}
                        name={connection.name}
                      />
                    </div>
                  ) : null}
                </div>
                <DefinitionList
                  items={[
                    {
                      term: "Daily spending limit",
                      value: connection.daily_budget_usd ? (
                        `${formatUsd(connection.daily_budget_usd)} per UTC day`
                      ) : (
                        <span className="text-bad">Not set — nothing can run</span>
                      ),
                    },
                    {
                      term: "Total spending limit",
                      value: connection.total_budget_usd
                        ? formatUsd(connection.total_budget_usd)
                        : "None",
                    },
                    {
                      term: "Concurrent requests",
                      value: formatNumber(connection.max_concurrent_requests),
                    },
                    {
                      term: "Requests per minute",
                      value: connection.requests_per_minute
                        ? formatNumber(connection.requests_per_minute)
                        : "No cap",
                    },
                    {
                      term: "Tokens per minute",
                      value: connection.tokens_per_minute
                        ? formatNumber(connection.tokens_per_minute)
                        : "No cap",
                    },
                    {
                      term: "Fresh-check responses",
                      value: connection.store_fresh_check_responses
                        ? "Stored at OpenAI"
                        : "Not stored at OpenAI",
                    },
                  ]}
                />
              </section>

              <section aria-label="Data sharing">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-ink text-[13px] font-semibold">
                    OpenAI data-sharing setting (your record)
                  </h3>
                  {owner ? (
                    <DataSharingButton
                      connectionId={connection.id}
                      setting={connection.data_sharing}
                      verifiedOn={connection.data_sharing_verified_on}
                      note={connection.data_sharing_note}
                    />
                  ) : null}
                </div>
                <DefinitionList
                  items={[
                    {
                      term: "Declared setting",
                      value: (
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge tone={sharing.tone}>{sharing.label}</Badge>
                          {connection.data_sharing_verified_on ? (
                            <span className="text-ink-muted">
                              checked {formatDate(connection.data_sharing_verified_on)}
                            </span>
                          ) : (
                            <span className="text-ink-muted">not checked</span>
                          )}
                        </span>
                      ),
                    },
                    ...(connection.data_sharing_note
                      ? [{ term: "Note", value: connection.data_sharing_note }]
                      : []),
                  ]}
                />
                <p className="text-ink-muted mt-3 max-w-3xl text-xs">
                  This is a record of what an owner saw in the OpenAI organization settings; it is
                  not a switch and this app cannot read or change it. It is separate from response
                  storage: conversations store each response at OpenAI so the next turn can continue
                  from it, whatever the data-sharing setting is.{" "}
                  <a
                    href={DATA_CONTROLS_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand hover:text-brand-strong inline-flex items-center gap-1 font-medium"
                  >
                    OpenAI data controls <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                </p>
              </section>

              <section aria-label="Models">
                <h3 className="text-ink mb-3 text-[13px] font-semibold">Verified models</h3>
                {verified.length === 0 ? (
                  <p className="text-ink-muted text-[13px]">
                    {connection.key_hint
                      ? "No model has been verified yet. Campaigns can only use verified models."
                      : "Add an API key to list the models it can use."}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {verified.map((model) => {
                      const profile = model.capabilities as unknown as CapabilityProfile | null;
                      return (
                        <li key={model.model_id} className="border-line rounded-xl border p-4">
                          <div className="mb-3 flex flex-wrap items-center gap-2">
                            <span className="text-ink font-mono text-[13px] font-semibold">
                              {model.model_id}
                            </span>
                            <Badge tone="good">Verified</Badge>
                            {!model.is_listed ? (
                              <Badge tone="bad">No longer visible to this key</Badge>
                            ) : null}
                            {model.shutdown_date ? (
                              <Badge tone="warn">Retires {formatDate(model.shutdown_date)}</Badge>
                            ) : null}
                            <span className="text-ink-muted text-xs">
                              checked <LocalTime value={model.verified_at} dateOnly />
                            </span>
                          </div>
                          {profile ? <DefinitionList items={capabilityRows(profile)} /> : null}
                          {profile?.notes?.length ? (
                            <ul className="text-ink-muted mt-3 list-disc pl-5 text-xs">
                              {profile.notes.map((note) => (
                                <li key={note}>{note}</li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {failed.length > 0 ? (
                  <div className="mt-3 flex flex-col gap-2">
                    {failed.map((model) => (
                      <Callout
                        key={model.model_id}
                        tone="warn"
                        title={`${model.model_id} could not be verified`}
                      >
                        {model.verification_error ?? "Verification failed."}
                      </Callout>
                    ))}
                  </div>
                ) : null}
                {owner && listed.length > 0 ? (
                  <div className="border-line bg-surface-alt/60 mt-4 rounded-xl border p-4">
                    <VerifyModelForm
                      connectionId={connection.id}
                      models={listed.map((model) => ({
                        id: model.model_id,
                        verified: model.verification_status === "verified",
                        shutdown: model.shutdown_date,
                        priced: priced.has(model.model_id),
                      }))}
                    />
                  </div>
                ) : null}
              </section>
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}

async function PricingTab({ session, supabase }: { session: Session; supabase: ServerClient }) {
  const owner = hasRole(session.role, "owner");
  const workspaceId = session.workspace.id;
  const [{ data: prices }, { data: models }] = await Promise.all([
    supabase.rpc("effective_prices", { p_workspace_id: workspaceId }),
    supabase
      .from("provider_models")
      .select("model_id")
      .eq("workspace_id", workspaceId)
      .eq("verification_status", "verified"),
  ]);
  const verified = [...new Set((models ?? []).map((model) => model.model_id))];
  const priced = new Set((prices ?? []).map((price) => price.model_id));
  const missing = verified.filter((id) => !priced.has(id));
  const perM = (value: number | null) =>
    value === null ? "—" : formatUsd(value, { precise: true });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-ink-muted max-w-3xl text-[13px]">
          Costs in this app are estimates: recorded token counts multiplied by the price version
          below. They are used for budgets and reports and are not invoices — your OpenAI billing
          page is authoritative. Work is blocked for a model with no price. Each row shows the
          version in effect; earlier usage keeps the version it was recorded with.
        </p>
        {owner ? <AddPriceButton workspaceId={workspaceId} modelIds={verified} /> : null}
      </div>
      {missing.length > 0 ? (
        <Callout tone="warn" role="alert" title="Verified models without a price">
          {missing.join(", ")} — campaigns using{" "}
          {missing.length === 1 ? "this model" : "these models"} cannot be launched until{" "}
          {owner ? "you add a price version" : "an owner adds a price version"}.
        </Callout>
      ) : null}
      <TableWrap label="Model prices in effect">
        <Table>
          <thead>
            <tr>
              <Th>Model</Th>
              <Th className="text-right">Input / 1M</Th>
              <Th className="text-right">Cached input / 1M</Th>
              <Th className="text-right">Output / 1M</Th>
              <Th>Long context</Th>
              <Th>Version</Th>
              <Th>Checked</Th>
              <Th>Source</Th>
            </tr>
          </thead>
          <tbody>
            {(prices ?? []).map((price) => (
              <Tr key={price.id}>
                <Td>
                  <span className="font-mono text-xs font-semibold">{price.model_id}</span>
                  {price.notes ? (
                    <div className="text-ink-muted max-w-xs text-xs whitespace-normal">
                      {price.notes}
                    </div>
                  ) : null}
                </Td>
                <Td className="tabular text-right">{perM(price.input_usd_per_mtok)}</Td>
                <Td className="tabular text-right">{perM(price.cached_input_usd_per_mtok)}</Td>
                <Td className="tabular text-right">{perM(price.output_usd_per_mtok)}</Td>
                <Td className="text-ink-muted text-xs">
                  {price.long_context_threshold_tokens
                    ? `Over ${formatNumber(price.long_context_threshold_tokens)} input tokens: input ×${price.long_context_input_multiplier ?? 1}, output ×${price.long_context_output_multiplier ?? 1}`
                    : "—"}
                </Td>
                <Td>
                  <span className="tabular">v{price.version}</span>{" "}
                  <Badge tone={price.workspace_id ? "brand" : "neutral"}>
                    {price.workspace_id ? "Workspace" : "Default"}
                  </Badge>
                </Td>
                <Td>{formatDate(price.verified_on)}</Td>
                <Td>
                  <a
                    href={price.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand hover:text-brand-strong inline-flex items-center gap-1"
                  >
                    Price list <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      {!owner ? <PermissionNote>Only owners can add price versions.</PermissionNote> : null}
    </div>
  );
}

function HealthRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean | null;
  detail: React.ReactNode;
}) {
  return (
    <li className="flex items-start justify-between gap-4 py-2.5 text-[13px]">
      <span className="text-ink font-medium">{label}</span>
      <span className="text-ink-muted flex items-center gap-2 text-right">
        {detail}
        {ok === null ? null : <Badge tone={ok ? "good" : "bad"}>{ok ? "OK" : "Check"}</Badge>}
      </span>
    </li>
  );
}

async function StatusTab({ session, supabase }: { session: Session; supabase: ServerClient }) {
  const admin = hasRole(session.role, "admin");
  const workspaceId = session.workspace.id;
  const [statusResult, { data: jobs }, audit] = await Promise.all([
    supabase.rpc("operational_status", { p_workspace_id: workspaceId }),
    supabase
      .from("jobs")
      .select(
        "id, kind, status, status_reason, last_error_class, last_error_message, scheduled_for, attempts, max_attempts, campaign_id, run_id, campaigns(name)",
      )
      .eq("workspace_id", workspaceId)
      .in("status", ["dead", "blocked"])
      .order("updated_at", { ascending: false })
      .limit(50),
    admin
      ? supabase
          .from("audit_events")
          .select("id, action, actor_kind, actor_user_id, entity_type, created_at, details")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false })
          .limit(40)
      : Promise.resolve({ data: null }),
  ]);
  if (statusResult.error) throw new Error("Operational status could not be loaded.");
  const status = statusResult.data as unknown as OperationalStatus;
  const ws = status.workspace;
  const beat = (name: string, maxAgeSeconds: number) => {
    const entry = status.scheduler[name];
    if (!entry || !entry.last_ok_at)
      return { ok: false, detail: "Has not run yet" as React.ReactNode };
    const fresh = (entry.seconds_since_ok ?? Infinity) <= maxAgeSeconds;
    return {
      ok: fresh && !entry.last_error,
      detail: (
        <span>
          Last ran <LocalTime value={entry.last_ok_at} />
          {entry.last_error ? (
            <span className="text-bad block">Last error: {entry.last_error}</span>
          ) : null}
        </span>
      ),
    };
  };
  const planner = beat("plan", 300);
  const dispatcher = beat("dispatch", 120);
  const maintenance = beat("maintenance", 60 * 60 * 30);
  const errors = Object.entries(ws.provider_errors_24h);
  const jobCounts = ["pending", "queued", "running", "waiting", "paused", "blocked", "dead"].map(
    (key) => ({ key, count: ws.jobs[key] ?? 0 }),
  );

  return (
    <div className="flex flex-col gap-6">
      {!status.consumers_activated ? (
        <Callout tone="warn" role="alert" title="Queue consumers are not activated">
          Schedules are planning and queueing work, but nothing wakes the worker that sends
          requests. Run <code className="font-mono text-xs">npm run queues:activate</code> for this
          Supabase project (see the README, “Queue activation”).
        </Callout>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Background system"
            description="Shared by all workspaces on this installation."
          />
          <CardBody>
            <ul className="divide-line divide-y">
              <HealthRow
                label="Scheduler (plans upcoming slots, every minute)"
                ok={planner.ok}
                detail={planner.detail}
              />
              <HealthRow
                label="Dispatcher (queues due work, every 10 seconds)"
                ok={dispatcher.ok}
                detail={dispatcher.detail}
              />
              <HealthRow
                label="Maintenance (retention, daily)"
                ok={status.scheduler.maintenance ? maintenance.ok : null}
                detail={status.scheduler.maintenance ? maintenance.detail : "Has not run yet"}
              />
              <HealthRow
                label="Queue consumers"
                ok={status.consumers_activated}
                detail={status.consumers_activated ? "Activated" : "Not activated"}
              />
              <HealthRow
                label="Queue backlog"
                ok={(status.queue.oldest_message_age_seconds ?? 0) < 900}
                detail={`${formatNumber(status.queue.length)} queued · ${formatNumber(status.queue.visible)} ready now${status.queue.oldest_message_age_seconds ? ` · oldest ${Math.round(status.queue.oldest_message_age_seconds / 60)} min` : ""}`}
              />
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="This workspace" />
          <CardBody>
            <ul className="divide-line divide-y">
              <HealthRow
                label="Emergency stop"
                ok={!ws.emergency_stop}
                detail={ws.emergency_stop ? "On — nothing is sent" : "Off"}
              />
              <HealthRow
                label="Requests in flight"
                ok={null}
                detail={formatNumber(ws.in_flight_requests)}
              />
              <HealthRow
                label="Stalled leases"
                ok={ws.stalled_leases === 0}
                detail={`${formatNumber(ws.stalled_leases)} · recovered automatically`}
              />
              <HealthRow
                label="Work overdue by more than 10 minutes"
                ok={ws.overdue_pending === 0}
                detail={formatNumber(ws.overdue_pending)}
              />
              <HealthRow
                label="Requests with an unknown outcome"
                ok={ws.unresolved_attempts === 0}
                detail={
                  ws.unresolved_attempts > 0 ? (
                    <Link
                      href="/usage#unresolved"
                      className="text-brand hover:text-brand-strong font-medium"
                    >
                      {formatNumber(ws.unresolved_attempts)} to review
                    </Link>
                  ) : (
                    "0"
                  )
                }
              />
              <HealthRow
                label="Provider errors, last 24 hours"
                ok={errors.length === 0}
                detail={
                  errors.length === 0
                    ? "None"
                    : errors.map(([name, count]) => `${humanize(name)} ×${count}`).join(" · ")
                }
              />
            </ul>
            <p className="text-ink-muted mt-3 text-xs">
              Jobs now:{" "}
              {jobCounts.map((item) => `${formatNumber(item.count)} ${item.key}`).join(" · ")}
            </p>
          </CardBody>
        </Card>
      </div>

      {ws.connections.some((connection) => connection.status !== "ok") ||
      ws.paused_campaigns.length > 0 ||
      ws.budget_exhausted.length > 0 ? (
        <Card>
          <CardHeader title="Holding work back" />
          <CardBody className="flex flex-col gap-2">
            {ws.connections
              .filter((connection) => connection.status !== "ok")
              .map((connection) => (
                <Callout
                  key={connection.id}
                  tone={connection.status === "error" ? "bad" : "neutral"}
                  title={`Connection "${connection.name}"`}
                >
                  {connection.status === "error"
                    ? (connection.status_message ?? "The last request failed.")
                    : "No API key stored."}{" "}
                  <Link
                    href="/settings?tab=connections"
                    className="text-brand hover:text-brand-strong font-medium"
                  >
                    Open connections
                  </Link>
                </Callout>
              ))}
            {ws.paused_campaigns.map((campaign) => (
              <Callout
                key={campaign.id}
                tone="warn"
                title={`Campaign "${campaign.name}" was paused automatically`}
              >
                {pauseReason(campaign.pause_reason)} {campaign.pause_detail ?? ""}{" "}
                <Link
                  href={`/campaigns/${campaign.id}`}
                  className="text-brand hover:text-brand-strong font-medium"
                >
                  Open campaign
                </Link>
              </Callout>
            ))}
            {ws.budget_exhausted.map((item, index) => (
              <Callout key={`${item.campaign_id}-${index}`} tone="warn" title="Budget reached">
                {reasonText(item.reason)}{" "}
                <Link
                  href={`/campaigns/${item.campaign_id}`}
                  className="text-brand hover:text-brand-strong font-medium"
                >
                  Open campaign
                </Link>
              </Callout>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <div>
        <h2 className="text-ink mb-1 text-[15px] font-semibold">Review queue</h2>
        <p className="text-ink-muted mb-3 text-[13px]">
          Jobs that stopped after repeated or permanent failures, or that are blocked. Retrying
          continues from the last saved step; a completed turn is never sent again.
        </p>
        {(jobs ?? []).length === 0 ? (
          <p className="border-line-strong bg-surface text-ink-muted rounded-2xl border border-dashed px-4 py-8 text-center text-[13px]">
            No jobs are waiting for review.
          </p>
        ) : (
          <TableWrap label="Jobs needing review">
            <Table>
              <thead>
                <tr>
                  <Th>Job</Th>
                  <Th>Campaign</Th>
                  <Th>Status</Th>
                  <Th>Reason</Th>
                  <Th className="text-right">Attempts</Th>
                  <Th className="text-right">Action</Th>
                </tr>
              </thead>
              <tbody>
                {(jobs ?? []).map((job) => (
                  <Tr key={job.id}>
                    <Td>
                      {job.run_id ? (
                        <Link
                          href={`/conversations/${job.run_id}`}
                          className="hover:text-brand-strong font-medium"
                        >
                          {jobKind(job.kind)}
                        </Link>
                      ) : (
                        <span className="font-medium">{jobKind(job.kind)}</span>
                      )}
                      <div className="text-ink-muted text-xs">
                        Scheduled <LocalTime value={job.scheduled_for} />
                      </div>
                    </Td>
                    <Td>
                      <Link
                        href={`/campaigns/${job.campaign_id}`}
                        className="hover:text-brand-strong"
                      >
                        {job.campaigns?.name ?? "Campaign"}
                      </Link>
                    </Td>
                    <Td>
                      <JobStatusBadge status={job.status} />
                    </Td>
                    <Td className="max-w-sm whitespace-normal">
                      {reasonText(job.status_reason) ?? errorClass(job.last_error_class) ?? "—"}
                      {job.last_error_message ? (
                        <div className="text-ink-muted text-xs break-words">
                          {job.last_error_message}
                        </div>
                      ) : null}
                    </Td>
                    <Td className="tabular text-right">
                      {job.attempts} of {job.max_attempts}
                    </Td>
                    <Td className="text-right">
                      {admin ? (
                        <RetryJobButton jobId={job.id} />
                      ) : (
                        <span className="text-ink-muted text-xs">Admins can retry</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </div>

      {admin ? (
        <div>
          <h2 className="text-ink mb-3 text-[15px] font-semibold">Recent changes</h2>
          {(audit.data ?? []).length === 0 ? (
            <p className="text-ink-muted text-[13px]">Nothing has been recorded yet.</p>
          ) : (
            <TableWrap label="Recent changes">
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>What</Th>
                    <Th>By</Th>
                  </tr>
                </thead>
                <tbody>
                  {(audit.data ?? []).map((event) => (
                    <Tr key={event.id}>
                      <Td>
                        <LocalTime value={event.created_at} />
                      </Td>
                      <Td>{humanize(event.action.replace(/\./g, " "))}</Td>
                      <Td className="text-ink-muted">
                        {event.actor_kind === "user"
                          ? event.actor_user_id === session.userId
                            ? "You"
                            : "A member"
                          : humanize(event.actor_kind)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </div>
      ) : null}
    </div>
  );
}
