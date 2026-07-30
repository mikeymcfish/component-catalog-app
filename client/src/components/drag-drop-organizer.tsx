import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Move, X, ArrowRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { getPositionLabel, getRowLabel } from "@/lib/compartment-labels";
import type { Component, Compartment, CaseWithCompartments } from "@shared/schema";
import CompartmentCell from "./compartment-cell";

interface DragDropOrganizerProps {
  isOpen: boolean;
  onClose: () => void;
  case_?: CaseWithCompartments;
}

export default function DragDropOrganizer({ isOpen, onClose, case_ }: DragDropOrganizerProps) {
  const [draggedComponent, setDraggedComponent] = useState<Component | null>(null);
  const [draggedFromPosition, setDraggedFromPosition] = useState<string | null>(null);
  const [targetPosition, setTargetPosition] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const moveMutation = useMutation({
    mutationFn: async ({ componentId, targetCompartmentId }: { componentId: number, targetCompartmentId: number }) => {
      const response = await fetch(`/api/components/${componentId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetCompartmentId })
      });

      if (!response.ok) {
        throw new Error('Failed to move component');
      }

      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Component moved",
        description: "Component has been successfully moved to the new position."
      });
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
      setDraggedComponent(null);
      setDraggedFromPosition(null);
      setTargetPosition(null);
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to move component. Please try again.",
        variant: "destructive"
      });
    }
  });

  const handleDragStart = (e: React.DragEvent, component: Component) => {
    setDraggedComponent(component);
    const compartment = case_?.compartments.find(c => c.component?.id === component.id);
    setDraggedFromPosition(compartment?.position || "Unknown");
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (e: React.DragEvent, targetCompartment: Compartment & { component?: Component }) => {
    e.preventDefault();

    if (!draggedComponent) return;

    // Don't allow dropping on occupied compartments
    if (targetCompartment.component) {
      toast({
        title: "Cannot move here",
        description: "Target compartment is already occupied.",
        variant: "destructive"
      });
      return;
    }

    setTargetPosition(targetCompartment.position);
    moveMutation.mutate({
      componentId: draggedComponent.id,
      targetCompartmentId: targetCompartment.id
    });
  };

  const renderGrid = () => {
    if (!case_) return null;

    const rows = case_.rows;
    const cols = case_.cols;
    const grid = [];

    grid.push(
      <div key="column-labels" className="grid gap-1" style={{ gridTemplateColumns: `2rem repeat(${cols}, 1fr)` }}>
        <div className="h-6" aria-hidden="true" />
        {Array.from({ length: cols }, (_, colIndex) => (
          <div
            key={`col-${colIndex + 1}`}
            className="flex h-6 items-center justify-center rounded bg-gray-100 text-xs font-semibold text-gray-600"
          >
            {colIndex + 1}
          </div>
        ))}
      </div>
    );

    for (let row = 0; row < rows; row++) {
      const rowCells = [];
      for (let col = 0; col < cols; col++) {
        const position = getPositionLabel(row + 1, col + 1);
        const compartment = case_.compartments.find(c => c.position === position && c.layer === "top");

        rowCells.push(
          <div key={`${row}-${col}`} className="aspect-square">
            <CompartmentCell
              compartment={compartment}
              position={position}
              onClick={() => {}}
              isHighlighted={true}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={(e) => compartment && handleDrop(e, compartment)}
              showLowQuantityWarning={false}
            />
          </div>
        );
      }
      grid.push(
        <div key={row} className="grid gap-1" style={{ gridTemplateColumns: `2rem repeat(${cols}, 1fr)` }}>
          <div className="flex items-center justify-center rounded bg-gray-100 text-xs font-semibold text-gray-600">
            {getRowLabel(row + 1)}
          </div>
          {rowCells}
        </div>
      );
    }

    return grid;
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Move className="h-5 w-5" />
            Drag & Drop Organizer - {case_?.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <h3 className="font-medium text-sm text-blue-900 mb-2">How to use:</h3>
            <ul className="text-xs text-blue-800 space-y-1">
              <li>• Drag components from their current positions</li>
              <li>• Drop them into empty compartments</li>
              <li>• Components will automatically organize in rows</li>
              <li>• Red dots indicate low quantity warnings</li>
              <li>• Orange dots show checked-out components</li>
            </ul>
          </div>

          {draggedComponent && (
            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex items-center gap-2 text-sm">
                <Badge variant="outline">{draggedFromPosition}</Badge>
                <ArrowRight className="h-4 w-4" />
                <span className="font-medium">{draggedComponent.name}</span>
                {targetPosition && (
                  <>
                    <ArrowRight className="h-4 w-4" />
                    <Badge variant="outline">{targetPosition}</Badge>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="border rounded-lg p-4 bg-gray-50">
            <h3 className="font-medium text-sm mb-3">Case Layout</h3>
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {renderGrid()}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={onClose}
              disabled={moveMutation.isPending}
            >
              <X className="h-4 w-4 mr-2" />
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
