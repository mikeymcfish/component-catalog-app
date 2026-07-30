import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import CustomCaseDesigner from "@/components/custom-case-designer";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  createUniformCustomCaseLayout,
  safeParseCustomCaseLayout,
  type CustomCaseLayoutGeometry,
} from "@shared/custom-case-layout";
import type { CaseWithCompartments } from "@shared/schema";

interface EditCaseLayoutDialogProps {
  case_: CaseWithCompartments | null;
  isOpen: boolean;
  onClose: () => void;
}

export default function EditCaseLayoutDialog({ case_, isOpen, onClose }: EditCaseLayoutDialogProps) {
  const [layout, setLayout] = useState<CustomCaseLayoutGeometry | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (!case_ || !isOpen) return;
    const dimensions = {
      rows: case_.rows,
      cols: case_.cols,
      hasBottom: Boolean(case_.hasBottom),
    };
    const parsed = safeParseCustomCaseLayout(case_.layoutGeometry, dimensions);
    setLayout(parsed.success
      ? parsed.data
      : createUniformCustomCaseLayout(dimensions.rows, dimensions.cols, dimensions.hasBottom));
  }, [case_, isOpen]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!case_ || !layout) throw new Error("No custom layout is ready to save");
      const response = await apiRequest("PATCH", `/api/cases/${case_.id}/layout`, {
        layoutGeometry: layout,
      });
      return response.json();
    },
    onSuccess: () => {
      if (!case_) return;
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cases", case_.id] });
      toast({ title: "Custom layout saved" });
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Could not save the layout",
        description: error instanceof Error ? error.message : "The custom geometry was rejected.",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !saveMutation.isPending && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit custom layout{case_ ? ` - ${case_.name}` : ""}</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-slate-500">
          Resize adjacent compartments independently. Saving changes their visual proportions without moving inventory.
        </p>

        {case_ && layout ? (
          <CustomCaseDesigner
            rows={case_.rows}
            cols={case_.cols}
            hasBottom={Boolean(case_.hasBottom)}
            value={layout}
            onChange={setLayout}
            disabled={saveMutation.isPending}
          />
        ) : null}

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={saveMutation.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => saveMutation.mutate()} disabled={!layout || saveMutation.isPending}>
            {saveMutation.isPending ? "Saving layout..." : "Save layout"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
