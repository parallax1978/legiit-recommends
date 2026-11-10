import { BarChart3, MessagesSquare, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/brand/logo";

const POINTS = [
  {
    icon: MessagesSquare,
    title: "Real conversations",
    text: "Every turn is sent to the model and answered by it. Nothing is scripted.",
  },
  {
    icon: BarChart3,
    title: "Independent fresh checks",
    text: "Baseline, scheduled and final measurements that never see the campaign.",
  },
  {
    icon: ShieldCheck,
    title: "Spending under control",
    text: "Every request is reserved against your daily and total caps before it is sent.",
  },
];

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="hero-dark relative flex flex-col justify-between gap-8 px-6 py-8 sm:px-10 lg:px-12 lg:py-12">
        <Logo inverted size={32} />
        <div className="max-w-md">
          <p className="eyebrow text-brand-soft">Recommendation campaigns, measured</p>
          <h1 className="mt-3 text-3xl leading-tight font-bold sm:text-4xl">
            Run the conversations.
            <br />
            <span className="text-gradient">See what changes.</span>
          </h1>
          <ul className="mt-8 hidden flex-col gap-5 sm:flex">
            {POINTS.map((point) => (
              <li key={point.title} className="flex gap-3">
                <span className="text-brand-soft mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
                  <point.icon className="size-4" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-white">{point.title}</span>
                  <span className="block text-[13px] text-white/70">{point.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="hidden text-xs text-white/50 lg:block">
          Invite-only. From the team behind Legiit.
        </p>
      </aside>
      <main className="bg-surface flex items-center justify-center px-6 py-10 sm:px-10">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
