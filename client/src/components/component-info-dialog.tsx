import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Model3dViewer from "@/components/model-3d-viewer";
import { COMPONENT_CATEGORIES } from "@/lib/constants";
import { getComponentModelQuarterTurns } from "@shared/component-model-rotation";
import type { Component, Compartment } from "@shared/schema";

interface ComponentInfoDialogProps {
  isOpen: boolean;
  onClose: () => void;
  component?: Component;
  compartment?: Compartment;
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleString();
}

function InfoRow({ label, value }: { label: string; value?: string | number | null }) {
  const displayValue = value === null || value === undefined || value === "" ? "None" : value;

  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">{displayValue}</dd>
    </div>
  );
}

function PhotoPreview({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (failed) {
    return (
      <div className="flex h-40 items-center justify-center p-4 text-center text-sm text-gray-500">
        Photo could not be displayed. Clear it in edit mode, then paste or upload the image again.
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className="max-h-64 w-full object-contain"
    />
  );
}

export default function ComponentInfoDialog({
  isOpen,
  onClose,
  component,
  compartment,
}: ComponentInfoDialogProps) {
  const category = component ? COMPONENT_CATEGORIES[component.categoryId - 1] : undefined;
  const checkedOutDate = formatDate(component?.checkedOutDate);
  const [activeTab, setActiveTab] = useState<"model" | "datasheet">("datasheet");

  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(component?.model3dUrl ? "model" : "datasheet");
  }, [component?.id, component?.model3dUrl, isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {component?.name || "Component"}
            {compartment && (
              <span className="ml-2 font-mono text-sm text-blue-600">
                {compartment.position}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {component && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
            <div className="space-y-4">
              <dl className="grid grid-cols-2 gap-4">
                <InfoRow label="Category" value={category?.label || "Other"} />
                <InfoRow label="Package" value={component.packageSize} />
                <InfoRow label="Quantity" value={component.quantity} />
                <InfoRow label="Minimum" value={component.minQuantity ?? 5} />
                <InfoRow
                  label="Checked Out"
                  value={component.checkedOut ? component.checkedOutBy || "Yes" : "No"}
                />
                <InfoRow label="Checked Out Date" value={checkedOutDate} />
              </dl>

              <div>
                <h3 className="text-sm font-medium text-gray-900">Notes</h3>
                <p className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
                  {component.notes || "No notes saved."}
                </p>
              </div>

              {component.photoUrl && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-medium text-gray-900">Photo</h3>
                    <Button asChild variant="outline" size="sm">
                      <a href={component.photoUrl} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </Button>
                  </div>
                  <div className="overflow-hidden rounded-md border border-gray-200 bg-gray-50">
                    <PhotoPreview src={component.photoUrl} alt={component.name} />
                  </div>
                </div>
              )}
            </div>

            <Tabs
              value={activeTab}
              onValueChange={value => setActiveTab(value as "model" | "datasheet")}
              className="min-w-0"
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <TabsList>
                  {component.model3dUrl && <TabsTrigger value="model">3D Model</TabsTrigger>}
                  <TabsTrigger value="datasheet">Datasheet</TabsTrigger>
                </TabsList>
                {activeTab === "datasheet" && component.datasheetUrl && (
                  <Button asChild variant="outline" size="sm">
                    <a href={component.datasheetUrl} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  </Button>
                )}
                {activeTab === "model" && component.model3dName && (
                  <span className="max-w-64 truncate text-xs text-gray-500" title={component.model3dName}>
                    {component.model3dName}
                  </span>
                )}
              </div>

              {component.model3dUrl && (
                <TabsContent value="model">
                  <Model3dViewer
                    src={component.model3dUrl}
                    name={component.name}
                    rotation={getComponentModelQuarterTurns(component.model3dRotation)}
                  />
                </TabsContent>
              )}

              <TabsContent value="datasheet">
                {component.datasheetUrl ? (
                  <div className="h-[60vh] overflow-hidden rounded-md border border-gray-200 bg-white">
                    <iframe
                      title={`${component.name} datasheet`}
                      src={component.datasheetUrl}
                      className="h-full w-full"
                    />
                  </div>
                ) : (
                  <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-gray-300 bg-gray-50 text-sm text-gray-500">
                    No datasheet linked.
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
