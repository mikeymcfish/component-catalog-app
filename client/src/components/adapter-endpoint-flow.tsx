import type { ComponentType, SVGProps } from "react";
import {
  ArrowRight,
  Cable,
  Plug,
  Power,
  Usb,
} from "lucide-react";
import { getAdapterEndpointTypeLabel, type Adapter } from "@/lib/adapters";

type IconProps = SVGProps<SVGSVGElement> & { title?: string };

function QfpIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...props}>
      <rect x="7" y="7" width="10" height="10" rx="1" />
      <circle cx="9.5" cy="9.5" r=".8" fill="currentColor" stroke="none" />
      <path d="M8 3v4M10.7 3v4M13.3 3v4M16 3v4M8 17v4M10.7 17v4M13.3 17v4M16 17v4M3 8h4M3 10.7h4M3 13.3h4M3 16h4M17 8h4M17 10.7h4M17 13.3h4M17 16h4" />
    </svg>
  );
}

function QfnIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...props}>
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <rect x="8.5" y="8.5" width="7" height="7" rx=".8" />
      <circle cx="6.7" cy="6.7" r=".8" fill="currentColor" stroke="none" />
      <path d="M9 4v3M12 4v3M15 4v3M9 17v3M12 17v3M15 17v3M4 9h3M4 12h3M4 15h3M17 9h3M17 12h3M17 15h3" />
    </svg>
  );
}

function SoicIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <rect x="7" y="4" width="10" height="16" rx="1.5" />
      <path d="M10 4a2 2 0 0 0 4 0M4 7h3M4 10.3h3M4 13.7h3M4 17h3M17 7h3M17 10.3h3M17 13.7h3M17 17h3" />
      <circle cx="9.7" cy="7" r=".7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function DipIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M7 4h10v16H7zM10 4a2 2 0 0 0 4 0" />
      <path d="M4 6h3M4 10h3M4 14h3M4 18h3M17 6h3M17 10h3M17 14h3M17 18h3" />
    </svg>
  );
}

function DSubIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M5 6h14l2 4-2 8H5l-2-8 2-4Z" />
      <circle cx="7.5" cy="10" r=".8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="10" r=".8" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="10" r=".8" fill="currentColor" stroke="none" />
      <circle cx="9.75" cy="14" r=".8" fill="currentColor" stroke="none" />
      <circle cx="14.25" cy="14" r=".8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function TerminalBlockIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M9 5v14M15 5v14" />
      <circle cx="6" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="18" cy="12" r="1.7" />
    </svg>
  );
}

function HeaderIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <circle cx="8" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="14" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="14" r="1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="14" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function endpointIcon(type: string | null): ComponentType<IconProps> {
  switch (type) {
    case "qfp":
      return QfpIcon;
    case "qfn":
      return QfnIcon;
    case "soic":
      return SoicIcon;
    case "dip":
      return DipIcon;
    case "d-sub":
      return DSubIcon;
    case "terminal-block":
      return TerminalBlockIcon;
    case "usb":
      return Usb;
    case "pin-header":
    case "debug-header":
      return HeaderIcon;
    case "power":
      return Power;
    case "cable":
      return Cable;
    default:
      return Plug;
  }
}

interface EndpointProps {
  label: string | null;
  type: string | null;
}

function Endpoint({ label, type }: EndpointProps) {
  const Icon = endpointIcon(type);
  const typeLabel = getAdapterEndpointTypeLabel(type);

  return (
    <div className="flex min-h-24 min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-violet-100 bg-violet-50/70 p-2.5 text-center min-[420px]:min-h-0 min-[420px]:flex-row min-[420px]:justify-start min-[420px]:gap-3 min-[420px]:p-3 min-[420px]:text-left">
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-violet-700 shadow-sm ring-1 ring-violet-100 min-[420px]:h-10 min-[420px]:w-10"
        title={typeLabel}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="break-words text-[10px] font-bold uppercase tracking-wider text-violet-600">
          {typeLabel}
        </p>
        <p className="mt-0.5 break-words text-sm font-semibold leading-5 text-gray-900">
          {label || "Endpoint not recorded"}
        </p>
      </div>
    </div>
  );
}

interface AdapterEndpointFlowProps {
  adapter: Pick<Adapter, "endpointA" | "endpointAType" | "endpointB" | "endpointBType">;
  className?: string;
}

export default function AdapterEndpointFlow({ adapter, className = "" }: AdapterEndpointFlowProps) {
  const accessibleA = adapter.endpointA || "unrecorded endpoint A";
  const accessibleB = adapter.endpointB || "unrecorded endpoint B";

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 ${className}`}
      aria-label={`${accessibleA} to ${accessibleB}. The arrow describes physical adaptation, not signal direction.`}
    >
      <Endpoint label={adapter.endpointA} type={adapter.endpointAType} />
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-600 text-white shadow-sm"
        title="Physical adaptation; not signal direction"
      >
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </span>
      <Endpoint label={adapter.endpointB} type={adapter.endpointBType} />
    </div>
  );
}
