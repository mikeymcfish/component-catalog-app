import type { Compartment } from "@shared/schema";

export function getRowLabel(row: number) {
  return String.fromCharCode(64 + row);
}

export function getPositionLabel(row: number, col: number) {
  return `${getRowLabel(row)}${col}`;
}

function isListPosition(position: string) {
  return /^Item \d+$/i.test(position);
}

export function formatCompartmentCoordinates(compartment: Pick<Compartment, "row" | "col" | "position">) {
  if (isListPosition(compartment.position)) {
    return "List slot";
  }

  const rowLabel = compartment.row > 0 ? getRowLabel(compartment.row) : compartment.position.replace(/\d+$/, "");
  const colLabel = compartment.col > 0 ? String(compartment.col) : compartment.position.replace(/^\D+/, "");

  return `Row ${rowLabel}, Column ${colLabel}`;
}

export function formatCompartmentLocation(compartment: Pick<Compartment, "layer" | "position" | "row" | "col">) {
  if (isListPosition(compartment.position)) {
    return compartment.position;
  }

  return `${compartment.layer} ${compartment.position} (${formatCompartmentCoordinates(compartment)})`;
}
