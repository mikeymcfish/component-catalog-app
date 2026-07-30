import { Clipboard, Copy, Edit, Eye, Plus } from "lucide-react";
import { COMPONENT_CATEGORIES } from "@/lib/constants";
import { formatCompartmentLocation } from "@/lib/compartment-labels";
import { getIconForCategory } from "./electronic-icons";
import type { Compartment, Component } from "@shared/schema";

interface CompartmentCellProps {
  compartment?: Compartment & { component?: Component };
  position: string;
  onClick: () => void;
  isHighlighted?: boolean;
  onDragStart?: (e: React.DragEvent, component: Component) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  showLowQuantityWarning?: boolean;
  interactionMode?: "view" | "edit";
  revealComponent?: boolean;
  hasCopiedComponent?: boolean;
  copiedComponentId?: number;
  onCopy?: (component: Component) => void;
  onPaste?: (compartment: Compartment, component?: Component) => void;
}

export default function CompartmentCell({
  compartment,
  position,
  onClick,
  isHighlighted = true,
  onDragStart,
  onDragOver,
  onDrop,
  showLowQuantityWarning = true,
  interactionMode = "edit",
  revealComponent = false,
  hasCopiedComponent = false,
  copiedComponentId,
  onCopy,
  onPaste
}: CompartmentCellProps) {
  const component = compartment?.component;
  const componentVisible = !!component;
  const componentVisualVisible = componentVisible && (interactionMode === "edit" || revealComponent);
  const componentConcealed = componentVisible && !componentVisualVisible;

  const getStockStatus = (quantity: number, minQuantity: number = 5) => {
    if (quantity === 0) return "empty";
    if (quantity <= minQuantity / 2) return "critical";
    if (quantity <= minQuantity) return "low";
    return "good";
  };

  const getStockColor = (status: string) => {
    switch (status) {
      case "good": return "bg-green-50 border-green-300";
      case "low": return "bg-yellow-50 border-yellow-300";
      case "critical": return "bg-red-50 border-red-300";
      default: return "bg-gray-50 border-dashed border-gray-300";
    }
  };

  const getCategoryColor = (category: string) => {
    const categoryInfo = COMPONENT_CATEGORIES.find(cat => cat.value === category);
    return categoryInfo?.color || "#6B7280";
  };

  // Get the electronic icon for the component category
  const getCategoryFromId = (categoryId: number) => {
    const categoryMap = {
      1: 'resistor', 2: 'capacitor', 3: 'ic', 4: 'diode', 5: 'transistor',
      6: 'inductor', 7: 'crystal', 8: 'connector', 9: 'led', 10: 'switch',
      11: 'sensor', 12: 'other'
    };
    return categoryMap[categoryId as keyof typeof categoryMap] || 'other';
  };

  const componentCategory = component ? getCategoryFromId(component.categoryId) : null;
  const stockStatus = component ? getStockStatus(component.quantity, component.minQuantity ?? 5) : "empty";
  const opacity = isHighlighted ? "opacity-100" : "opacity-30";

  // Use category color as background if component exists
  const backgroundColor = componentVisualVisible && componentCategory ? getCategoryColor(componentCategory) : undefined;
  const borderColor = componentVisible
    ? stockStatus === "critical" ? "#DC2626" :
      stockStatus === "low" ? "#D97706" : "#059669"
    : "#D1D5DB";

  const IconComponent = componentVisualVisible && componentCategory ? getIconForCategory(componentCategory) : null;
  const isInteractive = interactionMode === "edit" || !!component;
  const canCopy = interactionMode === "edit" && !!component && !!onCopy;
  const canPaste = interactionMode === "edit" && !!compartment && hasCopiedComponent && !!onPaste && copiedComponentId !== component?.id;
  const hasQuickActions = canCopy || canPaste;
  const cellTitle = componentVisible
    ? `${compartment ? `${formatCompartmentLocation(compartment)} | ` : ""}${component.name} | ${componentCategory} | ${component.packageSize || "No package"}`
    : componentConcealed
      ? `${position} | Occupied compartment — activate to reveal`
      : `${position} | Empty compartment`;
  const accessibleLabel = componentVisible
    ? `${compartment ? formatCompartmentLocation(compartment) : position}: ${component.name}${component.packageSize ? `, ${component.packageSize}` : ""}`
    : componentConcealed
      ? `${position}, occupied compartment. Activate to reveal details.`
      : `${position}, empty compartment${interactionMode === "edit" ? ". Activate to add a component." : "."}`;
  const binStateClass = componentConcealed
    ? "physical-case-bin--occupied physical-case-bin--concealed"
    : componentVisible
      ? "physical-case-bin--occupied physical-case-bin--revealed"
      : "physical-case-bin--empty";

  return (
    <div
      className={`physical-case-bin physical-case-bin--${interactionMode} ${binStateClass} group relative h-full w-full overflow-visible rounded-md border-2 transition-all duration-200 hover:z-40 focus:z-40 focus-within:z-40 ${isInteractive ? "cursor-pointer hover:border-blue-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2" : "cursor-default"} ${opacity}`}
      style={{
        backgroundColor: backgroundColor ? `${backgroundColor}20` : "#F9FAFB",
        borderColor: borderColor,
        borderStyle: componentVisible ? "solid" : "dashed"
      }}
      onClick={isInteractive ? onClick : undefined}
      onKeyDown={isInteractive ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      } : undefined}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={accessibleLabel}
      draggable={interactionMode === "edit" && !!component}
      onDragStart={(e) => {
        if (component && onDragStart) {
          onDragStart(e, component);
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (onDragOver) onDragOver(e);
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (onDrop) onDrop(e);
      }}
      title={cellTitle}
    >
      {/* Background Electronic Icon */}
      {IconComponent && (
        <div className="physical-case-bin-icon pointer-events-none absolute inset-0 flex items-center justify-center">
          <IconComponent className="w-8 h-8 text-gray-400 opacity-20" />
        </div>
      )}

      <div className="physical-case-bin-content pointer-events-none absolute inset-1 z-10 flex min-h-0 min-w-0 flex-col items-center justify-center overflow-hidden text-center text-xs">

        {componentVisible ? (
          <div className="flex h-full min-h-0 w-full min-w-0 flex-col items-center justify-center overflow-hidden text-center">
            <div className="physical-case-bin-label w-full min-w-0 text-center text-[10px] font-medium leading-tight text-gray-700">
              {component.name}
            </div>
            {component.packageSize && (
              <div className="physical-case-bin-package w-full min-w-0 text-center text-[8px] text-gray-500">
                {component.packageSize}
              </div>
            )}
            {/* Quantity shown only on hover */}
            <div
              className={`text-[8px] font-medium opacity-0 group-hover:opacity-100 transition-opacity ${
                stockStatus === "critical" ? "text-red-600" :
                stockStatus === "low" ? "text-orange-600" :
                "text-green-600"
              }`}
            >
              {component.quantity}
            </div>
          </div>
        ) : componentConcealed ? (
          <div className="physical-case-bin-position flex items-center justify-center">
            <div className="text-[10px] font-semibold text-gray-500">{position}</div>
          </div>
        ) : (
          <div className="physical-case-bin-position flex items-center justify-center">
            <div className="text-[10px] text-gray-400">
              {interactionMode === "view" ? position : "Empty"}
            </div>
          </div>
        )}
      </div>

      {interactionMode === "edit" && component && (
        <div
          className="physical-case-bin-text-preview pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-50 w-max max-w-[min(260px,70vw)] -translate-x-1/2 rounded-md border border-slate-600 bg-slate-950/95 px-2.5 py-2 text-left opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100 group-focus-within:opacity-100"
          aria-hidden="true"
        >
          <div className="break-words text-xs font-semibold leading-snug text-white">
            {component.name}
          </div>
          {component.packageSize && (
            <div className="mt-0.5 break-words text-[10px] leading-snug text-slate-300">
              {component.packageSize}
            </div>
          )}
        </div>
      )}

      {/* Status Indicators */}
      {componentVisible && (
        <>
          {/* Low Quantity Warning Dot */}
          {showLowQuantityWarning && stockStatus === "critical" && (
            <div className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full animate-pulse z-20"
                 title="Critical low quantity"></div>
          )}
          {showLowQuantityWarning && stockStatus === "low" && (
            <div className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full z-20"
                 title="Low quantity warning"></div>
          )}

          {/* Checkout Status Indicator */}
          {component.checkedOut && (
            <div className="absolute top-1 left-1 w-2 h-2 bg-orange-500 rounded-full z-20"
                 title={`Checked out by: ${component.checkedOutBy}`}></div>
          )}
        </>
      )}

      {interactionMode === "view" && (
        <span className="physical-case-bin-coordinate" aria-hidden="true">
          {position}
        </span>
      )}

      {/* Quick Action Overlay */}
      {isInteractive && (
        <div className="absolute inset-0 z-30 flex rounded-md bg-blue-600 bg-opacity-90 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus:opacity-100">
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {component ? (
              interactionMode === "view" ? (
                <Eye className="h-3.5 w-3.5 text-white" />
              ) : (
                <Edit className={`h-3.5 w-3.5 text-white ${hasQuickActions ? "-translate-y-1" : ""}`} />
              )
            ) : (
              <Plus className={`h-3.5 w-3.5 text-white ${canPaste ? "-translate-y-1" : ""}`} />
            )}
          </div>

          {hasQuickActions && (
            <div className={`absolute inset-x-1 bottom-1 grid h-7 gap-1 ${canCopy && canPaste ? "grid-cols-2" : "grid-cols-1"}`}>
              {canCopy && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCopy?.(component!);
                  }}
                  className="flex h-full min-w-0 items-center justify-center gap-1 rounded border border-white/80 bg-white px-1 text-[9px] font-semibold uppercase tracking-wide text-blue-700 shadow-sm hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  title="Copy compartment"
                  aria-label="Copy compartment"
                >
                  <Copy className="h-3 w-3" />
                  <span className={`leading-none ${canCopy && canPaste ? "sr-only" : ""}`}>Copy</span>
                </button>
              )}
              {canPaste && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPaste?.(compartment!, component);
                  }}
                  className="flex h-full min-w-0 items-center justify-center gap-1 rounded border border-white/80 bg-white px-1 text-[9px] font-semibold uppercase tracking-wide text-blue-700 shadow-sm hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  title="Paste copied compartment"
                  aria-label="Paste copied compartment"
                >
                  <Clipboard className="h-3 w-3" />
                  <span className={`leading-none ${canCopy && canPaste ? "sr-only" : ""}`}>Paste</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
