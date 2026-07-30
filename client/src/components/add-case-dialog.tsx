import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import CustomCaseDesigner from "@/components/custom-case-designer";
import { getCustomCaseModel } from "@shared/case-layouts";
import {
  createUniformCustomCaseLayout,
  safeParseCustomCaseLayout,
  type CustomCaseLayoutGeometry,
} from "@shared/custom-case-layout";
import type { Case } from "@shared/schema";

const caseSchema = z.object({
  name: z.string().min(1, "Case name is required"),
  caseType: z.enum(["preset", "custom"]),
  model: z.string().optional(),
  rows: z.coerce.number().int().min(1, "Use at least 1 row").max(26, "Use 26 rows or fewer").optional(),
  cols: z.coerce.number().int().min(1, "Use at least 1 column").max(24, "Use 24 columns or fewer").optional(),
  hasBottom: z.boolean().default(false),
  description: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.caseType === "preset" && !data.model) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Case model is required",
      path: ["model"],
    });
  }

  if (data.caseType === "custom") {
    if (!data.rows) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rows are required",
        path: ["rows"],
      });
    }

    if (!data.cols) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Columns are required",
        path: ["cols"],
      });
    }
  }
});

type CaseFormData = z.infer<typeof caseSchema>;

const CASE_MODELS = [
  { value: "LAYOUT-12x6-BOTH", label: "12x6 Both Layers (uniform squares)" },
  { value: "LAYOUT-6x4-TOP", label: "6x4 Top + 12x6 Bottom (mixed)" },
  { value: "LAYOUT-6x4-BOTH", label: "6x4 Both Layers (tall rectangles)" },
];

interface AddCaseDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (createdCase: Case) => void;
}

export default function AddCaseDialog({ isOpen, onClose, onSuccess }: AddCaseDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [customLayout, setCustomLayout] = useState<CustomCaseLayoutGeometry>(() =>
    createUniformCustomCaseLayout(6, 12, false),
  );

  const form = useForm<CaseFormData>({
    resolver: zodResolver(caseSchema),
    defaultValues: {
      name: "",
      caseType: "preset",
      model: "LAYOUT-12x6-BOTH",
      rows: 6,
      cols: 12,
      hasBottom: false,
      description: "",
    },
  });

  const caseType = form.watch("caseType");
  const customRows = form.watch("rows") || 1;
  const customCols = form.watch("cols") || 1;
  const customHasBottom = Boolean(form.watch("hasBottom"));

  useEffect(() => {
    if (caseType !== "custom") return;
    if (!Number.isInteger(customRows) || !Number.isInteger(customCols) || customRows < 1 || customCols < 1) return;
    setCustomLayout(createUniformCustomCaseLayout(customRows, customCols, customHasBottom));
  }, [caseType, customCols, customHasBottom, customRows]);

  const createCaseMutation = useMutation({
    mutationFn: async (data: CaseFormData) => {
      const payload = data.caseType === "custom"
        ? (() => {
            const rows = data.rows!;
            const cols = data.cols!;
            const hasBottom = Boolean(data.hasBottom);
            const parsedLayout = safeParseCustomCaseLayout(customLayout, { rows, cols, hasBottom });
            return {
            name: data.name,
            model: getCustomCaseModel(rows, cols, hasBottom),
            rows,
            cols,
            hasBottom,
            description: data.description,
            layoutGeometry: parsedLayout.success
              ? parsedLayout.data
              : createUniformCustomCaseLayout(rows, cols, hasBottom),
          };
        })()
        : {
            name: data.name,
            model: data.model,
            description: data.description,
          };

      const response = await apiRequest("POST", "/api/cases", payload);
      return response.json();
    },
    onSuccess: (createdCase: Case) => {
      queryClient.invalidateQueries({ queryKey: ["/api/cases"] });
      toast({ title: "Case created successfully" });
      form.reset();
      setCustomLayout(createUniformCustomCaseLayout(6, 12, false));
      onSuccess(createdCase);
    },
    onError: () => {
      toast({ title: "Failed to create case", variant: "destructive" });
    },
  });

  const onSubmit = (data: CaseFormData) => {
    createCaseMutation.mutate(data);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className={caseType === "custom" ? "max-h-[92vh] max-w-6xl overflow-y-auto" : "max-w-md"}>
        <DialogHeader>
          <DialogTitle>Case Creator</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Case Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., Main Resistors" {...field} autoComplete="off" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="caseType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Case Type</FormLabel>
                  <FormControl>
                    <div className="grid grid-cols-2 rounded-md border border-gray-200 bg-gray-50 p-1">
                      <Button
                        type="button"
                        variant={field.value === "preset" ? "default" : "ghost"}
                        onClick={() => field.onChange("preset")}
                        aria-pressed={field.value === "preset"}
                        className="h-8"
                      >
                        Preset
                      </Button>
                      <Button
                        type="button"
                        variant={field.value === "custom" ? "default" : "ghost"}
                        onClick={() => field.onChange("custom")}
                        aria-pressed={field.value === "custom"}
                        className="h-8"
                      >
                        Custom layout
                      </Button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {caseType === "preset" ? (
              <FormField
                control={form.control}
                name="model"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Case Model</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select case model" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CASE_MODELS.map((model) => (
                          <SelectItem key={model.value} value={model.value}>
                            {model.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <div className="space-y-5 rounded-xl border border-gray-200 bg-slate-50/60 p-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">1. Set the logical grid</h3>
                  <p className="mt-1 text-xs text-slate-500">Choose the starting rows and columns, then shape individual dividers below.</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="rows"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Rows</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={1}
                            max={26}
                            {...field}
                            onChange={(event) => field.onChange(event.target.valueAsNumber)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="cols"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Columns</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={1}
                            max={24}
                            {...field}
                            onChange={(event) => field.onChange(event.target.valueAsNumber)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="hasBottom"
                  render={({ field }) => (
                    <FormItem>
                      <label className="flex items-center gap-3 text-sm font-medium text-gray-700">
                        <input
                          type="checkbox"
                          checked={field.value}
                          onChange={(event) => field.onChange(event.target.checked)}
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600"
                        />
                        Include matching bottom layer
                      </label>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="border-t border-slate-200 pt-5">
                  <h3 className="mb-3 text-sm font-semibold text-slate-900">2. Shape the compartments</h3>
                  <CustomCaseDesigner
                    rows={customRows}
                    cols={customCols}
                    hasBottom={customHasBottom}
                    value={customLayout}
                    onChange={setCustomLayout}
                    disabled={createCaseMutation.isPending}
                  />
                </div>
              </div>
            )}

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Optional description..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex space-x-3 pt-4">
              <Button type="button" variant="outline" onClick={onClose} className="flex-1">
                Cancel
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={createCaseMutation.isPending}
              >
                {createCaseMutation.isPending ? "Creating..." : "Create Case"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
