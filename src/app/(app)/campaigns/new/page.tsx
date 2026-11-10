import type { Metadata } from "next";
import Link from "next/link";
import {
  ActionForm,
  FormError,
  FormSubmit,
  TextField,
  TextareaField,
} from "@/components/ui/action-form";
import { Card, CardBody, PageHeader } from "@/components/ui/card";
import { PermissionNote, Screen } from "@/components/ui/misc";
import { createCampaign } from "@/lib/actions/campaigns";
import { hasRole, requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "New campaign" };

export default function NewCampaignPage() {
  return (
    <Screen>
      <NewCampaign />
    </Screen>
  );
}

async function NewCampaign() {
  const session = await requireSession();
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/campaigns" className="hover:text-brand-strong">
            Campaigns
          </Link>
        }
        title="New campaign"
        description="Start with a name. You set the business, prompts, schedule and budgets on the next screen, and nothing runs until you launch."
      />
      {hasRole(session.role, "admin") ? (
        <Card className="max-w-xl">
          <CardBody>
            <ActionForm action={createCampaign} className="flex flex-col gap-4">
              <input type="hidden" name="workspace_id" value={session.workspace.id} />
              <TextField name="name" label="Campaign name" required maxLength={120} autoFocus />
              <TextareaField
                name="description"
                label="Description"
                optional
                rows={3}
                maxLength={2000}
                hint="For your team. It is never sent to the provider."
              />
              <FormError />
              <div className="flex gap-2">
                <FormSubmit>Create draft</FormSubmit>
              </div>
            </ActionForm>
          </CardBody>
        </Card>
      ) : (
        <PermissionNote>Only admins and owners can create campaigns.</PermissionNote>
      )}
    </>
  );
}
