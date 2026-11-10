import { ButtonLink } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      <Logo />
      <div>
        <h1 className="text-ink text-xl font-bold">Page not found</h1>
        <p className="text-ink-muted mt-2 max-w-sm text-[13px]">
          This page does not exist, or it belongs to a workspace you do not have access to.
        </p>
      </div>
      <ButtonLink href="/overview">Go to overview</ButtonLink>
    </main>
  );
}
