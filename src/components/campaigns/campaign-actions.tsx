"use client";

import { Copy, MoreHorizontal, Pause, Pencil, Play, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/dialog";
import { actionFailure, toastFailure } from "@/lib/action-failure";
import {
  deleteCampaign,
  discardCampaignDraft,
  duplicateCampaign,
  setCampaignArchived,
} from "@/lib/actions/campaigns";
import {
  cancelCampaign,
  pauseCampaign,
  requestTestConversation,
  resumeCampaign,
} from "@/lib/actions/operations";
import type { ActionResult } from "@/lib/result";

export interface CampaignActionTarget {
  id: string;
  name: string;
  status: string;
  archived: boolean;
  everLaunched: boolean;
}

const ACTIVE = ["scheduled", "baseline", "running", "finalizing"];
const EDITABLE = ["draft", "scheduled", "baseline", "running", "paused"];

interface Confirm {
  title: string;
  description: ReactNode;
  label: string;
  destructive?: boolean;
  action: () => Promise<ActionResult<unknown>>;
  redirectTo?: string;
}

/** The overflow menu on each campaign row. Actions are checked again on the server. */
export function CampaignRowMenu({
  campaign,
  isAdmin,
  isOwner,
}: {
  campaign: CampaignActionTarget;
  isAdmin: boolean;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const run = (
    action: () => Promise<ActionResult<unknown>>,
    redirectTo?: string | ((data: unknown) => string),
  ) =>
    startTransition(async () => {
      let result: ActionResult<unknown>;
      try {
        result = await action();
      } catch (error) {
        result = actionFailure(error);
      }
      setConfirm(null);
      if (!result.ok) {
        toastFailure(result);
        return;
      }
      if (result.message) toast.success(result.message);
      if (redirectTo)
        router.push(typeof redirectTo === "function" ? redirectTo(result.data) : redirectTo);
      else router.refresh();
    });

  const canDelete =
    !ACTIVE.includes(campaign.status) &&
    campaign.status !== "paused" &&
    (campaign.everLaunched ? isOwner : isAdmin);

  return (
    <>
      <Menu>
        <MenuTrigger
          className="text-ink-muted hover:bg-surface-sunken hover:text-ink rounded-full p-1.5"
          aria-label={`Actions for ${campaign.name}`}
          disabled={pending}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </MenuTrigger>
        <MenuContent>
          <MenuItem asChild>
            <Link href={`/campaigns/${campaign.id}`}>Open</Link>
          </MenuItem>
          {isAdmin ? (
            <>
              {EDITABLE.includes(campaign.status) && !campaign.archived ? (
                <MenuItem asChild>
                  <Link href={`/campaigns/${campaign.id}/edit`}>
                    <Pencil className="text-ink-muted size-4" aria-hidden="true" />
                    Edit
                  </Link>
                </MenuItem>
              ) : null}
              <MenuItem
                onSelect={() =>
                  run(
                    () => duplicateCampaign(campaign.id),
                    (id) => `/campaigns/${String(id)}/edit`,
                  )
                }
              >
                <Copy className="text-ink-muted size-4" aria-hidden="true" />
                Duplicate
              </MenuItem>
              {ACTIVE.includes(campaign.status) ? (
                <MenuItem onSelect={() => run(() => pauseCampaign(campaign.id))}>
                  <Pause className="text-ink-muted size-4" aria-hidden="true" />
                  Pause
                </MenuItem>
              ) : null}
              {campaign.status === "paused" ? (
                <MenuItem onSelect={() => run(() => resumeCampaign(campaign.id))}>
                  <Play className="text-ink-muted size-4" aria-hidden="true" />
                  Resume
                </MenuItem>
              ) : null}
              {["draft", "completed", "canceled"].includes(campaign.status) ? (
                <MenuItem
                  onSelect={() => run(() => setCampaignArchived(campaign.id, !campaign.archived))}
                >
                  {campaign.archived ? "Restore from archive" : "Archive"}
                </MenuItem>
              ) : null}
              {ACTIVE.includes(campaign.status) || campaign.status === "paused" ? (
                <>
                  <MenuSeparator />
                  <MenuItem
                    destructive
                    onSelect={() =>
                      setConfirm({
                        title: `Cancel "${campaign.name}"?`,
                        description:
                          "No further conversations or fresh checks will be dispatched, and this cannot be undone. Requests already sent to the provider finish and are recorded.",
                        label: "Cancel campaign",
                        destructive: true,
                        action: () => cancelCampaign(campaign.id),
                      })
                    }
                  >
                    Cancel campaign
                  </MenuItem>
                </>
              ) : null}
              {canDelete ? (
                <>
                  <MenuSeparator />
                  <MenuItem
                    destructive
                    onSelect={() =>
                      setConfirm({
                        title: `Delete "${campaign.name}"?`,
                        description: campaign.everLaunched
                          ? "Its conversations, fresh checks, classifications and configuration are deleted permanently. Usage records are kept for accounting. Export what you need first."
                          : "This draft is deleted permanently.",
                        label: "Delete campaign",
                        destructive: true,
                        action: () => deleteCampaign(campaign.id),
                        redirectTo: "/campaigns",
                      })
                    }
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    Delete
                  </MenuItem>
                </>
              ) : null}
            </>
          ) : null}
        </MenuContent>
      </Menu>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => (open ? null : setConfirm(null))}
      >
        {confirm ? (
          <AlertDialogContent
            title={confirm.title}
            description={confirm.description}
            footer={
              <>
                <AlertDialogCancel asChild>
                  <Button variant="secondary" disabled={pending}>
                    Keep it
                  </Button>
                </AlertDialogCancel>
                <Button
                  variant={confirm.destructive ? "danger" : "primary"}
                  disabled={pending}
                  aria-busy={pending}
                  onClick={() => run(confirm.action, confirm.redirectTo)}
                >
                  {confirm.label}
                </Button>
              </>
            }
          />
        ) : null}
      </AlertDialog>
    </>
  );
}

/** Primary lifecycle controls on the campaign detail page. */
export function CampaignControls({
  campaign,
  isAdmin,
  hasPendingChanges,
}: {
  campaign: CampaignActionTarget;
  isAdmin: boolean;
  hasPendingChanges: boolean;
}) {
  if (!isAdmin) return null;
  const id = campaign.id;
  return (
    <>
      {campaign.status === "draft" && !campaign.archived ? (
        <>
          <Link
            href={`/campaigns/${id}/edit`}
            className="border-line-strong bg-surface text-ink hover:bg-surface-alt inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-semibold"
          >
            <Pencil className="size-4" aria-hidden="true" />
            Edit
          </Link>
          <Link
            href={`/campaigns/${id}/review`}
            className="bg-brand shadow-glow hover:bg-brand-strong inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-semibold text-white"
          >
            Review and launch
          </Link>
        </>
      ) : null}
      {["scheduled", "baseline", "running", "paused"].includes(campaign.status) ? (
        <Link
          href={hasPendingChanges ? `/campaigns/${id}/review` : `/campaigns/${id}/edit`}
          className="border-line-strong bg-surface text-ink hover:bg-surface-alt inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-semibold"
        >
          <Pencil className="size-4" aria-hidden="true" />
          {hasPendingChanges ? "Review pending changes" : "Edit"}
        </Link>
      ) : null}
      {ACTIVE.includes(campaign.status) ? (
        <ActionButton action={() => pauseCampaign(id)}>
          <Pause className="size-4" aria-hidden="true" />
          Pause
        </ActionButton>
      ) : null}
      {campaign.status === "paused" ? (
        <ActionButton action={() => resumeCampaign(id)} variant="primary">
          <Play className="size-4" aria-hidden="true" />
          Resume
        </ActionButton>
      ) : null}
      {ACTIVE.includes(campaign.status) || campaign.status === "paused" ? (
        <ActionButton
          action={() => cancelCampaign(id)}
          variant="outline-danger"
          confirm={{
            title: `Cancel "${campaign.name}"?`,
            description:
              "No further conversations or fresh checks will be dispatched, and this cannot be undone. Requests already sent to the provider finish and are recorded.",
            confirmLabel: "Cancel campaign",
            destructive: true,
          }}
        >
          Cancel campaign
        </ActionButton>
      ) : null}
    </>
  );
}

export function TestConversationButton({
  campaignId,
  disabled,
  variant = "secondary",
}: {
  campaignId: string;
  disabled?: boolean;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  return (
    <ActionButton
      action={() => requestTestConversation(campaignId)}
      variant={variant}
      disabled={disabled}
      confirm={{
        title: "Run one test conversation?",
        description:
          "One complete sequence is sent to the provider now, using the saved configuration. It is billed like any other requests, reserved against the connection's daily limit, marked as a test and left out of campaign results.",
        confirmLabel: "Run test conversation",
      }}
      onDone={(result) => {
        if (result.ok && typeof result.data === "string")
          router.push(`/conversations/${result.data}`);
      }}
    >
      Test conversation
    </ActionButton>
  );
}

export function DiscardChangesButton({ campaignId }: { campaignId: string }) {
  return (
    <ActionButton
      action={() => discardCampaignDraft(campaignId)}
      variant="outline-danger"
      redirectTo={`/campaigns/${campaignId}`}
      confirm={{
        title: "Discard pending changes?",
        description:
          "Your unapplied edits are thrown away. The campaign keeps running with its current configuration.",
        confirmLabel: "Discard changes",
        destructive: true,
      }}
    >
      Discard changes
    </ActionButton>
  );
}
