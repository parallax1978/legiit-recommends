"use client";

import { useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import {
  ActionForm,
  FormError,
  FormSubmit,
  SelectField,
  TextField,
} from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Badge, Callout } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/form";
import { changePassword } from "@/lib/actions/auth";
import {
  deleteWorkspace,
  inviteMember,
  removeMember,
  resendInvitation,
  revokeInvitation,
  setEmergencyStop,
  updateMemberRole,
  updateProfile,
  updateWorkspace,
} from "@/lib/actions/settings";

type Role = "owner" | "admin" | "member";

/** Lets a signed-in person replace their password without waiting for an email. */
export function ChangePasswordForm() {
  return (
    <ActionForm action={changePassword} resetOnSuccess className="flex max-w-md flex-col gap-4">
      <TextField
        name="current_password"
        label="Current password"
        type="password"
        autoComplete="current-password"
        required
      />
      <TextField
        name="password"
        id="new-password"
        label="New password"
        type="password"
        autoComplete="new-password"
        hint="At least 10 characters."
        minLength={10}
        maxLength={72}
        required
      />
      <TextField
        name="confirm"
        id="confirm-new-password"
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        required
      />
      <FormError />
      <div>
        <FormSubmit>Change password</FormSubmit>
      </div>
    </ActionForm>
  );
}

export function ProfileForm({ displayName, email }: { displayName: string; email: string }) {
  return (
    <ActionForm action={updateProfile} className="flex max-w-md flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="profile-email">Email</Label>
        <Input id="profile-email" value={email} readOnly disabled />
      </div>
      <TextField
        name="display_name"
        label="Your name"
        optional
        defaultValue={displayName}
        maxLength={120}
        autoComplete="name"
      />
      <FormError />
      <div>
        <FormSubmit>Save profile</FormSubmit>
      </div>
    </ActionForm>
  );
}

export function WorkspaceForm({
  workspaceId,
  name,
  retentionDays,
}: {
  workspaceId: string;
  name: string;
  retentionDays: number | null;
}) {
  return (
    <ActionForm action={updateWorkspace} className="flex max-w-md flex-col gap-4">
      <input type="hidden" name="workspace_id" value={workspaceId} />
      <TextField name="name" label="Workspace name" defaultValue={name} required maxLength={80} />
      <TextField
        name="retention_days"
        label="Keep prompt and response text for (days)"
        optional
        type="number"
        min={1}
        max={3650}
        inputMode="numeric"
        defaultValue={retentionDays ?? ""}
        hint="Older transcripts and fresh-check answers have their text removed once a day. Counts, classifications, usage and the audit trail are kept. Leave blank to keep everything."
      />
      <FormError />
      <div>
        <FormSubmit>Save workspace</FormSubmit>
      </div>
    </ActionForm>
  );
}

export function EmergencyStopControl({
  workspaceId,
  enabled,
  reason,
}: {
  workspaceId: string;
  enabled: boolean;
  reason: string | null;
}) {
  const [note, setNote] = useState("");
  if (enabled) {
    return (
      <Callout
        tone="bad"
        title="Emergency stop is on"
        action={
          <ActionButton
            action={() => setEmergencyStop(workspaceId, false, null)}
            variant="secondary"
            confirm={{
              title: "Release the emergency stop?",
              description:
                "Work that was held will be queued again, and running campaigns continue on their schedules. Provider requests will resume.",
              confirmLabel: "Release and resume",
            }}
          >
            Release
          </ActionButton>
        }
      >
        No provider requests are sent for any campaign, test or tool in this workspace.
        {reason ? ` Reason: ${reason}` : ""}
      </Callout>
    );
  }
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <p className="text-ink-muted text-[13px]">
        Stops every provider request in this workspace at once: campaigns, fresh checks, test
        conversations, model verification and generation. Requests already sent to the provider
        cannot be recalled and are shown until they resolve.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="stop-reason">Reason (optional, shown to members)</Label>
        <Input
          id="stop-reason"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={200}
        />
      </div>
      <div>
        <ActionButton
          action={() => setEmergencyStop(workspaceId, true, note.trim() || null)}
          variant="danger"
          confirm={{
            title: "Stop all provider requests?",
            description:
              "Nothing new will be sent to the provider until an owner releases the stop. Campaign schedules keep advancing, so slots that pass while stopped follow each campaign's missed-slot setting.",
            confirmLabel: "Stop everything",
            destructive: true,
          }}
        >
          Stop all provider requests
        </ActionButton>
      </div>
    </div>
  );
}

export function DeleteWorkspaceForm({ workspaceId, name }: { workspaceId: string; name: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline-danger">Delete workspace…</Button>
      </DialogTrigger>
      <DialogContent
        title="Delete this workspace?"
        description="This permanently deletes every campaign, transcript, result, prompt, connection and stored API key in it. It cannot be undone."
        size="sm"
      >
        <ActionForm action={deleteWorkspace} className="flex flex-col gap-4">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <TextField
            name="confirm_name"
            label={
              <>
                Type the workspace name to confirm: <span className="font-semibold">{name}</span>
              </>
            }
            autoComplete="off"
            required
          />
          <FormError />
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <FormSubmit variant="danger">Delete workspace</FormSubmit>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function InviteForm({ workspaceId }: { workspaceId: string }) {
  return (
    <ActionForm
      action={inviteMember}
      resetOnSuccess
      className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto]"
    >
      <input type="hidden" name="workspace_id" value={workspaceId} />
      <TextField name="email" label="Email address" type="email" autoComplete="off" required />
      <SelectField name="role" label="Role" defaultValue="member">
        <option value="member">Member — view and export</option>
        <option value="admin">Admin — manage campaigns</option>
        <option value="owner">Owner — full control</option>
      </SelectField>
      <div className="sm:pt-[26px]">
        <FormSubmit>Send invitation</FormSubmit>
      </div>
      <div className="sm:col-span-3">
        <FormError />
      </div>
    </ActionForm>
  );
}

export function MemberRowActions({
  workspaceId,
  userId,
  role,
  isSelf,
  label,
}: {
  workspaceId: string;
  userId: string;
  role: Role;
  isSelf: boolean;
  label: string;
}) {
  const [next, setNext] = useState<Role>(role);
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Select
        value={next}
        onChange={(event) => setNext(event.target.value as Role)}
        aria-label={`Role for ${label}`}
        className="h-8 w-28 text-xs"
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
        <option value="owner">Owner</option>
      </Select>
      <ActionButton
        action={() => updateMemberRole(workspaceId, userId, next)}
        size="sm"
        disabled={next === role}
      >
        Change
      </ActionButton>
      <ActionButton
        action={() => removeMember(workspaceId, userId)}
        size="sm"
        variant="outline-danger"
        confirm={{
          title: isSelf ? "Leave this workspace?" : `Remove ${label}?`,
          description: isSelf
            ? "You will lose access to this workspace immediately."
            : "They lose access to this workspace immediately. Their past actions stay in the audit trail.",
          confirmLabel: isSelf ? "Leave workspace" : "Remove member",
          destructive: true,
        }}
        redirectTo={isSelf ? "/overview" : undefined}
      >
        {isSelf ? "Leave" : "Remove"}
      </ActionButton>
    </div>
  );
}

export function ResendInvitationButton({
  workspaceId,
  email,
  role,
}: {
  workspaceId: string;
  email: string;
  role: Role;
}) {
  return (
    <ActionButton
      action={() => resendInvitation(workspaceId, email, role)}
      size="sm"
      variant="secondary"
      confirm={{
        title: "Send this invitation again?",
        description: `${email} gets a new email. The link in the earlier one stops working.`,
        confirmLabel: "Send again",
      }}
    >
      Send again
    </ActionButton>
  );
}

export function RevokeInvitationButton({
  invitationId,
  email,
}: {
  invitationId: string;
  email: string;
}) {
  return (
    <ActionButton
      action={() => revokeInvitation(invitationId)}
      size="sm"
      variant="outline-danger"
      confirm={{
        title: "Revoke this invitation?",
        description: `${email} will no longer be able to join with it.`,
        confirmLabel: "Revoke",
        destructive: true,
      }}
    >
      Revoke
    </ActionButton>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge tone={role === "owner" ? "brand" : role === "admin" ? "info" : "neutral"}>
      {role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member"}
    </Badge>
  );
}
