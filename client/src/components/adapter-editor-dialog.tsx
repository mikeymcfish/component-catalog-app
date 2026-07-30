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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  ADAPTER_CATEGORY_SUGGESTIONS,
  ADAPTER_ENDPOINT_TYPE_OPTIONS,
  isAdapterEndpointType,
  type Adapter,
  type AdapterInput,
} from "@/lib/adapters";

interface AdapterEditorDialogProps {
  open: boolean;
  adapter: Adapter | null;
  onClose: () => void;
}

function optionalText(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function isAdapterImageUrl(value: string) {
  return isHttpUrl(value) || value.startsWith("/uploads/");
}

function editableEndpointType(value: string | null | undefined) {
  return isAdapterEndpointType(value) ? value : "other";
}

export default function AdapterEditorDialog({
  open,
  adapter,
  onClose,
}: AdapterEditorDialogProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [modelNumber, setModelNumber] = useState("");
  const [productUrl, setProductUrl] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [endpointA, setEndpointA] = useState("");
  const [endpointAType, setEndpointAType] = useState("other");
  const [endpointB, setEndpointB] = useState("");
  const [endpointBType, setEndpointBType] = useState("other");
  const [quantity, setQuantity] = useState("1");
  const [location, setLocation] = useState("");
  const [compatibility, setCompatibility] = useState("");
  const [notes, setNotes] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    setName(adapter?.name ?? "");
    setCategory(adapter?.category ?? "");
    setManufacturer(adapter?.manufacturer ?? "");
    setModelNumber(adapter?.modelNumber ?? "");
    setProductUrl(adapter?.productUrl ?? "");
    setImageUrl(adapter?.imageUrl ?? "");
    setEndpointA(adapter?.endpointA ?? "");
    setEndpointAType(editableEndpointType(adapter?.endpointAType));
    setEndpointB(adapter?.endpointB ?? "");
    setEndpointBType(editableEndpointType(adapter?.endpointBType));
    setQuantity(String(adapter?.quantity ?? 1));
    setLocation(adapter?.location ?? "");
    setCompatibility(adapter?.compatibility ?? "");
    setNotes(adapter?.notes ?? "");
  }, [adapter, open]);

  const saveMutation = useMutation({
    mutationFn: async (payload: AdapterInput) => {
      const response = adapter
        ? await apiRequest("PATCH", `/api/adapters/${adapter.id}`, payload)
        : await apiRequest("POST", "/api/adapters", payload);
      return response.json() as Promise<Adapter>;
    },
    onSuccess: () => {
      toast({ title: adapter ? "Adapter updated" : "Adapter added" });
      onClose();
    },
    onError: (error) => {
      toast({
        title: adapter ? "Could not update adapter" : "Could not add adapter",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        predicate: query => {
          const root = query.queryKey[0];
          return typeof root === "string" && root.startsWith("/api/adapters");
        },
      });
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = name.trim();
    const normalizedCategory = category.trim();
    const normalizedQuantity = Number(quantity);
    const normalizedProductUrl = optionalText(productUrl);
    const normalizedImageUrl = optionalText(imageUrl);
    const normalizedEndpointA = endpointA.trim();
    const normalizedEndpointB = endpointB.trim();

    if (!normalizedName || !normalizedCategory) {
      toast({
        title: "Name and category are required",
        variant: "destructive",
      });
      return;
    }

    if (Boolean(normalizedEndpointA) !== Boolean(normalizedEndpointB)) {
      toast({
        title: "Complete both physical endpoints",
        description: "Provide both endpoint labels, or leave both blank.",
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

    if (normalizedProductUrl && !isHttpUrl(normalizedProductUrl)) {
      toast({
        title: "Product page must use an HTTP(S) address",
        variant: "destructive",
      });
      return;
    }

    if (normalizedImageUrl && !isAdapterImageUrl(normalizedImageUrl)) {
      toast({
        title: "Image must use HTTP(S) or a managed /uploads/ path",
        variant: "destructive",
      });
      return;
    }

    saveMutation.mutate({
      name: normalizedName,
      category: normalizedCategory,
      manufacturer: optionalText(manufacturer),
      modelNumber: optionalText(modelNumber),
      productUrl: normalizedProductUrl,
      imageUrl: normalizedImageUrl,
      endpointA: optionalText(endpointA),
      endpointAType: normalizedEndpointA ? endpointAType : null,
      endpointB: optionalText(endpointB),
      endpointBType: normalizedEndpointB ? endpointBType : null,
      quantity: normalizedQuantity,
      location: optionalText(location),
      compatibility: optionalText(compatibility),
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
          <DialogTitle>{adapter ? "Edit adapter" : "Add adapter"}</DialogTitle>
          <DialogDescription>
            Record adapters, breakouts, sockets, and cables available for hardware integration and debugging.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="adapter-name">Name</Label>
              <Input
                id="adapter-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g., SOIC-8 to DIP-8 programming adapter"
                maxLength={200}
                autoFocus
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="adapter-category">Category</Label>
              <Input
                id="adapter-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                placeholder="e.g., Connector Breakout"
                maxLength={100}
                list="adapter-category-suggestions"
                required
              />
              <datalist id="adapter-category-suggestions">
                {ADAPTER_CATEGORY_SUGGESTIONS.map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
            </div>

            <div className="space-y-2">
              <Label htmlFor="adapter-quantity">Quantity</Label>
              <Input
                id="adapter-quantity"
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
              <Label htmlFor="adapter-manufacturer">Manufacturer</Label>
              <Input
                id="adapter-manufacturer"
                value={manufacturer}
                onChange={(event) => setManufacturer(event.target.value)}
                placeholder="e.g., DSD TECH"
                maxLength={200}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="adapter-model">Model number</Label>
              <Input
                id="adapter-model"
                value={modelNumber}
                onChange={(event) => setModelNumber(event.target.value)}
                placeholder="e.g., SH-U09C2"
                maxLength={200}
              />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="adapter-product-url">Product page</Label>
              <Input
                id="adapter-product-url"
                type="url"
                value={productUrl}
                onChange={(event) => setProductUrl(event.target.value)}
                placeholder="https://www.amazon.com/dp/..."
                maxLength={2_000}
              />
              <p className="text-xs text-gray-500">
                Keep the purchase or manufacturer page with the adapter for pinouts and specifications.
              </p>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="adapter-image-url">Image URL</Label>
              <Input
                id="adapter-image-url"
                type="text"
                inputMode="url"
                value={imageUrl}
                onChange={(event) => setImageUrl(event.target.value)}
                placeholder="https://.../adapter-photo.jpg or /uploads/..."
                maxLength={2_000}
              />
              <p className="text-xs text-gray-500">
                Paste a direct HTTP(S) image address or a managed upload path to show a photo on the adapter card.
              </p>
            </div>

            <fieldset className="space-y-4 rounded-xl border border-violet-200 bg-violet-50/50 p-4 sm:col-span-2">
              <legend className="px-1 text-sm font-semibold text-gray-900">Physical endpoints</legend>
              <p className="text-xs leading-5 text-gray-600">
                Optionally record what each side physically accepts or exposes. Provide both labels or
                leave both blank. A → B is for finding the adapter; it does not claim signal direction,
                level shifting, or protocol conversion.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="adapter-endpoint-a">Endpoint A</Label>
                  <Input
                    id="adapter-endpoint-a"
                    value={endpointA}
                    onChange={(event) => setEndpointA(event.target.value)}
                    placeholder="e.g., SOIC-8 socket"
                    maxLength={200}
                  />
                  <Select value={endpointAType} onValueChange={setEndpointAType}>
                    <SelectTrigger aria-label="Endpoint A icon">
                      <SelectValue placeholder="Choose interface icon" />
                    </SelectTrigger>
                    <SelectContent>
                      {ADAPTER_ENDPOINT_TYPE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="adapter-endpoint-b">Endpoint B</Label>
                  <Input
                    id="adapter-endpoint-b"
                    value={endpointB}
                    onChange={(event) => setEndpointB(event.target.value)}
                    placeholder="e.g., DIP-8 male header"
                    maxLength={200}
                  />
                  <Select value={endpointBType} onValueChange={setEndpointBType}>
                    <SelectTrigger aria-label="Endpoint B icon">
                      <SelectValue placeholder="Choose interface icon" />
                    </SelectTrigger>
                    <SelectContent>
                      {ADAPTER_ENDPOINT_TYPE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </fieldset>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="adapter-location">Location</Label>
              <Input
                id="adapter-location"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="e.g., Electronics bench, adapter drawer"
                maxLength={300}
              />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="adapter-compatibility">Compatibility</Label>
              <Textarea
                id="adapter-compatibility"
                value={compatibility}
                onChange={(event) => setCompatibility(event.target.value)}
                placeholder="e.g., SOIC-8, 1.27 mm pitch to DIP-8; supports 25-series SPI flash at 3.3 V"
                maxLength={4_000}
                className="min-h-24 resize-y"
              />
              <p className="text-xs text-gray-500">
                Include connector genders, pin counts, package sizes, pitch, supported devices or protocols,
                voltage and current limits, pin mapping, and any level-shifting or isolation caveats.
              </p>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="adapter-notes">Notes</Label>
              <Textarea
                id="adapter-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Pinout details, included cables, setup notes, or usage reminders"
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
              {saveMutation.isPending ? "Saving..." : adapter ? "Save changes" : "Add adapter"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
