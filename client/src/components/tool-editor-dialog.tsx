import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  TOOL_CATEGORY_SUGGESTIONS,
  type Tool,
  type ToolInput,
} from "@/lib/tools";

interface ToolEditorDialogProps {
  open: boolean;
  tool: Tool | null;
  onClose: () => void;
}

function optionalText(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}

export default function ToolEditorDialog({
  open,
  tool,
  onClose,
}: ToolEditorDialogProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [modelNumber, setModelNumber] = useState("");
  const [productUrl, setProductUrl] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [location, setLocation] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [notes, setNotes] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    setName(tool?.name ?? "");
    setCategory(tool?.category ?? "");
    setManufacturer(tool?.manufacturer ?? "");
    setModelNumber(tool?.modelNumber ?? "");
    setProductUrl(tool?.productUrl ?? "");
    setImageUrl(tool?.imageUrl ?? "");
    setQuantity(String(tool?.quantity ?? 1));
    setLocation(tool?.location ?? "");
    setCapabilities(tool?.capabilities ?? "");
    setNotes(tool?.notes ?? "");
  }, [open, tool]);

  const saveMutation = useMutation({
    mutationFn: async (payload: ToolInput) => {
      const response = tool
        ? await apiRequest("PATCH", `/api/tools/${tool.id}`, payload)
        : await apiRequest("POST", "/api/tools", payload);
      return response.json() as Promise<Tool>;
    },
    onSuccess: () => {
      toast({ title: tool ? "Tool updated" : "Tool added" });
      onClose();
    },
    onError: (error) => {
      toast({
        title: tool ? "Could not update tool" : "Could not add tool",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/tools"] });
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = name.trim();
    const normalizedCategory = category.trim();
    const normalizedQuantity = Number(quantity);

    if (!normalizedName || !normalizedCategory) {
      toast({
        title: "Name and category are required",
        variant: "destructive",
      });
      return;
    }

    if (!Number.isInteger(normalizedQuantity) || normalizedQuantity < 1) {
      toast({
        title: "Quantity must be a whole number of at least 1",
        variant: "destructive",
      });
      return;
    }

    saveMutation.mutate({
      name: normalizedName,
      category: normalizedCategory,
      manufacturer: optionalText(manufacturer),
      modelNumber: optionalText(modelNumber),
      productUrl: optionalText(productUrl),
      imageUrl: optionalText(imageUrl),
      quantity: normalizedQuantity,
      location: optionalText(location),
      capabilities: optionalText(capabilities),
      notes: optionalText(notes),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saveMutation.isPending) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tool ? "Edit tool" : "Add tool"}</DialogTitle>
          <DialogDescription>
            Record the equipment and capabilities available for hardware debugging.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="tool-name">Name</Label>
              <Input
                id="tool-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g., Bench oscilloscope"
                maxLength={200}
                autoFocus
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tool-category">Category</Label>
              <Input
                id="tool-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                placeholder="e.g., Oscilloscope"
                maxLength={100}
                list="tool-category-suggestions"
                required
              />
              <datalist id="tool-category-suggestions">
                {TOOL_CATEGORY_SUGGESTIONS.map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
            </div>

            <div className="space-y-2">
              <Label htmlFor="tool-quantity">Quantity</Label>
              <Input
                id="tool-quantity"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tool-manufacturer">Manufacturer</Label>
              <Input
                id="tool-manufacturer"
                value={manufacturer}
                onChange={(event) => setManufacturer(event.target.value)}
                placeholder="e.g., Rigol"
                maxLength={200}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tool-model">Model number</Label>
              <Input
                id="tool-model"
                value={modelNumber}
                onChange={(event) => setModelNumber(event.target.value)}
                placeholder="e.g., DS1054Z"
                maxLength={200}
              />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="tool-product-url">Product page</Label>
              <Input
                id="tool-product-url"
                type="url"
                value={productUrl}
                onChange={(event) => setProductUrl(event.target.value)}
                placeholder="https://www.amazon.com/dp/..."
                maxLength={2_000}
              />
              <p className="text-xs text-gray-500">
                Keep the purchase or manufacturer page with the tool for manuals and specifications.
              </p>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="tool-image-url">Image URL</Label>
              <Input
                id="tool-image-url"
                type="url"
                value={imageUrl}
                onChange={(event) => setImageUrl(event.target.value)}
                placeholder="https://.../tool-photo.jpg"
                maxLength={2_000}
              />
              <p className="text-xs text-gray-500">
                Paste a direct image address to show a photo on the tool card.
              </p>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="tool-location">Location</Label>
              <Input
                id="tool-location"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="e.g., Electronics bench, upper shelf"
                maxLength={300}
              />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="tool-capabilities">Capabilities</Label>
              <Textarea
                id="tool-capabilities"
                value={capabilities}
                onChange={(event) => setCapabilities(event.target.value)}
                placeholder="e.g., 4 channels, 100 MHz, serial decode; includes 10x passive probes"
                maxLength={4_000}
                className="min-h-24 resize-y"
              />
              <p className="text-xs text-gray-500">
                Include ranges, bandwidth, channels, probe types, protocols, or other limits that affect debugging.
              </p>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="tool-notes">Notes</Label>
              <Textarea
                id="tool-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Setup details, accessories, calibration notes, or usage reminders"
                maxLength={4_000}
                className="min-h-20 resize-y"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving..." : tool ? "Save changes" : "Add tool"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
