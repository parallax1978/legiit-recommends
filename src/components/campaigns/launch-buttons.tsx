"use client";

import { Rocket } from "lucide-react";
import { ActionButton } from "@/components/ui/action-button";
import { applyCampaignChanges, launchCampaign } from "@/lib/actions/campaigns";

export function LaunchButton({
  campaignId,
  revisionId,
  disabled,
  summary,
}: {
  campaignId: string;
  revisionId: string;
  disabled: boolean;
  summary: string;
}) {
  return (
    <ActionButton
      action={() => launchCampaign(campaignId, revisionId)}
      variant="primary"
      size="lg"
      disabled={disabled}
      redirectTo={`/campaigns/${campaignId}`}
      confirm={{
        title: "Launch this campaign?",
        description: (
          <>
            <p>{summary}</p>
            <p className="mt-2">
              Launching starts paid requests to the provider on the schedule you reviewed, up to the
              budgets you set. You can pause or cancel at any time; requests already sent still
              complete and are billed.
            </p>
          </>
        ),
        confirmLabel: "Launch campaign",
      }}
    >
      <Rocket className="size-4" aria-hidden="true" />
      Launch campaign
    </ActionButton>
  );
}

export function ApplyChangesButton({
  campaignId,
  revisionId,
  disabled,
  newGroup,
}: {
  campaignId: string;
  revisionId: string;
  disabled: boolean;
  newGroup: boolean;
}) {
  return (
    <ActionButton
      action={() => applyCampaignChanges(campaignId, revisionId)}
      variant="primary"
      size="lg"
      disabled={disabled}
      redirectTo={`/campaigns/${campaignId}`}
      confirm={{
        title: "Apply these changes?",
        description: (
          <>
            <p>
              A new revision is created and used for conversations and fresh checks dispatched from
              now on. Work already run keeps the prompts, aliases, model settings, prices and
              revision it used.
            </p>
            {newGroup ? (
              <p className="mt-2">
                The fresh-check settings changed, so a new comparison group starts with its own
                baseline. Results from different groups are never combined.
              </p>
            ) : null}
          </>
        ),
        confirmLabel: "Apply changes",
      }}
    >
      Apply changes
    </ActionButton>
  );
}
