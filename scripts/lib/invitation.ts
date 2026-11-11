// What to tell the operator when Supabase would not send an invitation email. Pure, so each
// case is tested. A cause is named only when the Auth server's own error code names it: any
// other failure gets the way around it and nothing else.

const WITH_LINK = "run the command again with --link to get a one-time link, which needs no email";

export function inviteFailureHint(error: { code?: string | null; status?: number | null }): string {
  if (error.code === "email_address_not_authorized") {
    return (
      "The project is on Supabase's built-in email service, which delivers only to the people " +
      "on the project's Supabase team. Give the project its own sender (README, Email), or " +
      `${WITH_LINK}.`
    );
  }
  if (error.code === "over_email_send_rate_limit" || error.status === 429) {
    return (
      "The project has sent as many emails as it may for now. Supabase's built-in email " +
      `service allows only a couple an hour. Try again later, or ${WITH_LINK}.`
    );
  }
  return `To get in without an email, ${WITH_LINK}.`;
}
