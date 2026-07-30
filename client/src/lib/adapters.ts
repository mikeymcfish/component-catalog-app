import {
  ADAPTER_ENDPOINT_TYPE_VALUES,
  type Adapter as CatalogAdapter,
  type AdapterEndpointType,
} from "@shared/schema";

export type Adapter = CatalogAdapter;

export type AdapterInput = Omit<Adapter, "id">;

const ADAPTER_ENDPOINT_TYPE_LABELS: Record<AdapterEndpointType, string> = {
  qfp: "QFP / TQFP package",
  qfn: "QFN / MLF package",
  soic: "SOIC / SOP package",
  dip: "DIP package / header",
  "d-sub": "D-sub connector",
  "terminal-block": "Screw terminal block",
  usb: "USB connector",
  "pin-header": "Pin / IDC header",
  "debug-header": "Debug / programming header",
  power: "Power connector",
  cable: "Cable / lead",
  other: "Other interface",
};

export const ADAPTER_ENDPOINT_TYPE_OPTIONS = ADAPTER_ENDPOINT_TYPE_VALUES.map((value) => ({
  value,
  label: ADAPTER_ENDPOINT_TYPE_LABELS[value],
}));

export function isAdapterEndpointType(value: unknown): value is AdapterEndpointType {
  return typeof value === "string"
    && (ADAPTER_ENDPOINT_TYPE_VALUES as readonly string[]).includes(value);
}

export function getAdapterEndpointTypeLabel(value: string | null | undefined) {
  return isAdapterEndpointType(value) ? ADAPTER_ENDPOINT_TYPE_LABELS[value] : "Interface";
}

export const ADAPTER_CATEGORY_SUGGESTIONS = [
  "IC Package / Programming Adapter",
  "D-Sub / Serial Inline Breakout",
  "D-Sub / Serial Terminal Breakout",
  "Debug / Programming Adapter",
  "USB / Serial Adapter",
  "Connector Breakout",
  "Pin Header / IDC Adapter",
  "Protocol Adapter",
  "Power Adapter",
  "Cable Adapter",
  "Measurement Adapter",
  "Other",
] as const;
