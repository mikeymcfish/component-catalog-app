import { Clipboard, Copy, FileText, ImageOff, Plus } from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCompartmentCoordinates } from "@/lib/compartment-labels";
import { COMPONENT_CATEGORIES } from "@/lib/constants";
import type { CaseWithCompartments, Compartment, Component } from "@shared/schema";
import { useEffect, useState } from "react";

type InteractionMode = "view" | "edit";

type CompartmentWithComponent = Compartment & { component?: Component };

interface CaseComponentViewsProps {
  case_: CaseWithCompartments;
  searchQuery?: string;
  interactionMode: InteractionMode;
  copiedComponentId?: number;
  hasCopiedComponent: boolean;
  onCompartmentClick: (compartment: Compartment, component?: Component) => void;
  onCopyCompartment: (component: Component) => void;
  onPasteCompartment: (compartment: Compartment, component?: Component) => void;
}

interface ComponentEntry {
  compartment: CompartmentWithComponent;
  component: Component;
  category: (typeof COMPONENT_CATEGORIES)[number];
}

function LayerScrollTarget({ caseId, layer }: { caseId: number; layer: "top" | "bottom" }) {
  return (
    <div
      aria-hidden="true"
      className="h-px scroll-mt-24"
      data-case-id={caseId}
      data-case-layer={layer}
    />
  );
}

function getCategory(component: Component) {
  return COMPONENT_CATEGORIES[component.categoryId - 1] || COMPONENT_CATEGORIES[COMPONENT_CATEGORIES.length - 1];
}

function matchesSearch(entry: ComponentEntry, query: string) {
  if (!query) return true;

  const normalizedQuery = query.toLowerCase();
  return (
    entry.component.name.toLowerCase().includes(normalizedQuery) ||
    entry.category.value.toLowerCase().includes(normalizedQuery) ||
    entry.category.label.toLowerCase().includes(normalizedQuery) ||
    (entry.component.packageSize?.toLowerCase().includes(normalizedQuery) ?? false) ||
    (entry.component.notes?.toLowerCase().includes(normalizedQuery) ?? false) ||
    entry.compartment.position.toLowerCase().includes(normalizedQuery) ||
    entry.compartment.layer.toLowerCase().includes(normalizedQuery)
  );
}

function getComponentEntries(case_: CaseWithCompartments, searchQuery = "") {
  return case_.compartments
    .filter((compartment): compartment is CompartmentWithComponent & { component: Component } => !!compartment.component)
    .map((compartment) => ({
      compartment,
      component: compartment.component,
      category: getCategory(compartment.component),
    }))
    .filter((entry) => matchesSearch(entry, searchQuery));
}

function sortCompartmentsForList(left: CompartmentWithComponent, right: CompartmentWithComponent) {
  return left.layer.localeCompare(right.layer) ||
    left.row - right.row ||
    left.col - right.col ||
    left.id - right.id;
}

function isListPosition(position: string) {
  return /^Item \d+$/i.test(position);
}

function getLocationLabel(compartment: CompartmentWithComponent) {
  return isListPosition(compartment.position)
    ? compartment.position
    : `${compartment.layer} ${compartment.position}`;
}

function getLocationDescription(compartment: CompartmentWithComponent) {
  return isListPosition(compartment.position)
    ? "List slot"
    : formatCompartmentCoordinates(compartment);
}

function matchesCompartmentSearch(compartment: CompartmentWithComponent, query: string) {
  if (!query) return true;

  const normalizedQuery = query.toLowerCase();
  if (
    compartment.position.toLowerCase().includes(normalizedQuery) ||
    compartment.layer.toLowerCase().includes(normalizedQuery)
  ) {
    return true;
  }

  if (!compartment.component) return false;

  return matchesSearch({
    compartment,
    component: compartment.component,
    category: getCategory(compartment.component),
  }, query);
}

function stopAction(event: MouseEvent, action: () => void) {
  event.stopPropagation();
  action();
}

function ComponentActions({
  interactionMode,
  component,
  compartment,
  copiedComponentId,
  hasCopiedComponent,
  onCopyCompartment,
  onPasteCompartment,
}: {
  interactionMode: InteractionMode;
  component: Component;
  compartment: CompartmentWithComponent;
  copiedComponentId?: number;
  hasCopiedComponent: boolean;
  onCopyCompartment: (component: Component) => void;
  onPasteCompartment: (compartment: Compartment, component?: Component) => void;
}) {
  if (interactionMode !== "edit") return null;

  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={(event) => stopAction(event, () => onCopyCompartment(component))}
        title="Copy compartment"
      >
        <Copy className="h-3 w-3" />
        Copy
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={(event) => stopAction(event, () => onPasteCompartment(compartment, component))}
        disabled={!hasCopiedComponent || copiedComponentId === component.id}
        title="Paste copied compartment here"
      >
        <Clipboard className="h-3 w-3" />
        Paste
      </Button>
    </div>
  );
}

function EmptySlotActions({
  compartment,
  hasCopiedComponent,
  onCompartmentClick,
  onPasteCompartment,
}: {
  compartment: CompartmentWithComponent;
  hasCopiedComponent: boolean;
  onCompartmentClick: (compartment: Compartment, component?: Component) => void;
  onPasteCompartment: (compartment: Compartment, component?: Component) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={(event) => stopAction(event, () => onCompartmentClick(compartment))}
        title="Add component"
      >
        <Plus className="h-3 w-3" />
        Add
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={(event) => stopAction(event, () => onPasteCompartment(compartment))}
        disabled={!hasCopiedComponent}
        title="Paste copied compartment here"
      >
        <Clipboard className="h-3 w-3" />
        Paste
      </Button>
    </div>
  );
}

function PhotoTile({ component }: { component: Component }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [component.photoUrl]);

  if (!component.photoUrl || failed) {
    return (
      <div className="flex h-36 items-center justify-center bg-gray-100 text-gray-400">
        <ImageOff className="h-8 w-8" />
      </div>
    );
  }

  return (
    <img
      src={component.photoUrl}
      alt={component.name}
      onError={() => setFailed(true)}
      className="h-36 w-full object-contain bg-gray-50"
    />
  );
}

export function CaseListView({
  case_,
  searchQuery = "",
  interactionMode,
  copiedComponentId,
  hasCopiedComponent,
  onCompartmentClick,
  onCopyCompartment,
  onPasteCompartment,
}: CaseComponentViewsProps) {
  const entries = getComponentEntries(case_, searchQuery);
  const hasBottomLayer = case_.compartments.some(compartment => compartment.layer === "bottom");

  if (entries.length === 0) {
    return (
      <>
        <LayerScrollTarget caseId={case_.id} layer="top" />
        <div className="rounded-md border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          No matching components.
        </div>
        {hasBottomLayer ? <LayerScrollTarget caseId={case_.id} layer="bottom" /> : null}
      </>
    );
  }

  return (
    <>
      <LayerScrollTarget caseId={case_.id} layer="top" />
      <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
        <Table>
          <TableHeader>
            <TableRow
            >
              <TableHead>Location</TableHead>
              <TableHead>Component</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Package</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>Files</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map(({ compartment, component, category }) => (
              <TableRow
                key={component.id}
                data-case-id={case_.id}
                data-case-layer={compartment.layer}
                onClick={() => onCompartmentClick(compartment, component)}
                className="scroll-mt-24 cursor-pointer"
              >
                <TableCell>
                  <div className="font-mono text-xs text-gray-900">{compartment.layer} {compartment.position}</div>
                  <div className="text-xs text-gray-500">{formatCompartmentCoordinates(compartment)}</div>
                </TableCell>
                <TableCell className="font-medium text-gray-900">{component.name}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: category.color }}
                    />
                    {category.label}
                  </span>
                </TableCell>
                <TableCell>{component.packageSize || "None"}</TableCell>
                <TableCell className="text-right">{component.quantity}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 text-gray-500">
                    {component.datasheetUrl && <FileText className="h-4 w-4" aria-label="Datasheet linked" />}
                    {component.photoUrl && <span className="text-xs">Photo</span>}
                  </div>
                </TableCell>
                <TableCell>
                  <ComponentActions
                    interactionMode={interactionMode}
                    component={component}
                    compartment={compartment}
                    copiedComponentId={copiedComponentId}
                    hasCopiedComponent={hasCopiedComponent}
                    onCopyCompartment={onCopyCompartment}
                    onPasteCompartment={onPasteCompartment}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {hasBottomLayer ? <LayerScrollTarget caseId={case_.id} layer="bottom" /> : null}
    </>
  );
}

export function CaseUnorganizedListView({
  case_,
  searchQuery = "",
  interactionMode,
  copiedComponentId,
  hasCopiedComponent,
  onCompartmentClick,
  onCopyCompartment,
  onPasteCompartment,
}: CaseComponentViewsProps) {
  const compartments = [...case_.compartments]
    .sort(sortCompartmentsForList)
    .filter((compartment) => matchesCompartmentSearch(compartment, searchQuery));

  if (compartments.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
        No matching list slots.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-32">Slot</TableHead>
            <TableHead>Component</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Package</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead>Files</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {compartments.map((compartment) => {
            const component = compartment.component;
            const category = component ? getCategory(component) : null;
            const rowIsInteractive = interactionMode === "edit" || !!component;

            return (
              <TableRow
                key={compartment.id}
                data-case-id={case_.id}
                data-case-layer={compartment.layer}
                onClick={() => {
                  if (rowIsInteractive) {
                    onCompartmentClick(compartment, component);
                  }
                }}
                className={rowIsInteractive ? "cursor-pointer" : undefined}
              >
                <TableCell>
                  <div className="font-mono text-xs text-gray-900">{getLocationLabel(compartment)}</div>
                  <div className="text-xs text-gray-500">{getLocationDescription(compartment)}</div>
                </TableCell>
                <TableCell className={component ? "font-medium text-gray-900" : "text-gray-400"}>
                  {component?.name ?? "Empty"}
                </TableCell>
                <TableCell>
                  {category ? (
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: category.color }}
                      />
                      {category.label}
                    </span>
                  ) : (
                    <span className="text-gray-400">None</span>
                  )}
                </TableCell>
                <TableCell>{component?.packageSize || "None"}</TableCell>
                <TableCell className="text-right">{component?.quantity ?? "-"}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2 text-gray-500">
                    {component?.datasheetUrl && <FileText className="h-4 w-4" aria-label="Datasheet linked" />}
                    {component?.photoUrl && <span className="text-xs">Photo</span>}
                    {!component?.datasheetUrl && !component?.photoUrl && <span className="text-gray-400">None</span>}
                  </div>
                </TableCell>
                <TableCell>
                  {component ? (
                    <ComponentActions
                      interactionMode={interactionMode}
                      component={component}
                      compartment={compartment}
                      copiedComponentId={copiedComponentId}
                      hasCopiedComponent={hasCopiedComponent}
                      onCopyCompartment={onCopyCompartment}
                      onPasteCompartment={onPasteCompartment}
                    />
                  ) : interactionMode === "edit" ? (
                    <EmptySlotActions
                      compartment={compartment}
                      hasCopiedComponent={hasCopiedComponent}
                      onCompartmentClick={onCompartmentClick}
                      onPasteCompartment={onPasteCompartment}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function CaseImageView({
  case_,
  searchQuery = "",
  interactionMode,
  copiedComponentId,
  hasCopiedComponent,
  onCompartmentClick,
  onCopyCompartment,
  onPasteCompartment,
}: CaseComponentViewsProps) {
  const entries = getComponentEntries(case_, searchQuery);
  const hasBottomLayer = case_.compartments.some(compartment => compartment.layer === "bottom");

  if (entries.length === 0) {
    return (
      <>
        <LayerScrollTarget caseId={case_.id} layer="top" />
        <div className="rounded-md border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          No matching component photos.
        </div>
        {hasBottomLayer ? <LayerScrollTarget caseId={case_.id} layer="bottom" /> : null}
      </>
    );
  }

  return (
    <>
      <LayerScrollTarget caseId={case_.id} layer="top" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
        {entries.map(({ compartment, component, category }) => (
          <div
            key={component.id}
            data-case-id={case_.id}
            data-case-layer={compartment.layer}
            role="button"
            tabIndex={0}
            onClick={() => onCompartmentClick(compartment, component)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onCompartmentClick(compartment, component);
              }
            }}
            className="scroll-mt-24 overflow-hidden rounded-md border border-gray-200 bg-white transition-colors hover:border-blue-300"
          >
            <PhotoTile component={component} />
            <div className="space-y-3 p-3">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-gray-500">
                    {compartment.layer} {compartment.position}
                  </span>
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: category.color }}
                    title={category.label}
                  />
                </div>
                <div className="mt-1 text-sm font-medium leading-snug text-gray-900">{component.name}</div>
                <div className="mt-1 text-xs text-gray-500">{formatCompartmentCoordinates(compartment)}</div>
                <div className="mt-1 text-xs text-gray-500">
                  {component.packageSize || "No package"} | Qty {component.quantity}
                </div>
              </div>
              <ComponentActions
                interactionMode={interactionMode}
                component={component}
                compartment={compartment}
                copiedComponentId={copiedComponentId}
                hasCopiedComponent={hasCopiedComponent}
                onCopyCompartment={onCopyCompartment}
                onPasteCompartment={onPasteCompartment}
              />
            </div>
          </div>
        ))}
      </div>
      {hasBottomLayer ? <LayerScrollTarget caseId={case_.id} layer="bottom" /> : null}
    </>
  );
}
