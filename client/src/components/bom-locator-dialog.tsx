import { useMemo, useState, type FormEvent } from "react";
import { AlertCircle, ExternalLink, FileText, Printer, Sparkles, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

type BomStatus = "matched" | "short" | "missing";

interface BomReportMatch {
  componentId: number;
  name: string;
  packageSize: string | null;
  quantity: number;
  caseName: string;
  position: string;
  layer: string;
  confidence: number;
  reasons: string[];
}

interface BomReportItem {
  itemNumber: number;
  reference: string | null;
  name: string;
  description: string;
  requiredQuantity: number;
  availableQuantity: number;
  status: BomStatus;
  short: boolean;
  score: number;
  confidence: number;
  matches: BomReportMatch[];
}

interface BomReport {
  sourceFile: string;
  itemCount: number;
  matchedCount: number;
  shortCount: number;
  missingCount: number;
  pdfUrl: string;
  htmlUrl?: string;
  ai: {
    enabled: boolean;
    used: boolean;
    model: string | null;
    summary: string | null;
    error?: string;
  };
  items: BomReportItem[];
}

interface BomLocatorDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

function statusLabel(item: BomReportItem) {
  if (item.status === "short") return "Short*";
  if (item.status === "matched") return "Matched";
  return "Missing";
}

function statusClass(status: BomStatus) {
  switch (status) {
    case "matched":
      return "border-green-200 bg-green-50 text-green-700";
    case "short":
      return "border-amber-200 bg-amber-50 text-amber-800";
    default:
      return "border-red-200 bg-red-50 text-red-700";
  }
}

function locationSummary(item: BomReportItem) {
  if (item.matches.length === 0) return "Not found";
  return item.matches
    .map(match => `${match.caseName} ${match.layer} ${match.position}`)
    .join("; ");
}

export default function BomLocatorDialog({ isOpen, onClose }: BomLocatorDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<BomReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const { toast } = useToast();

  const shortOrMissingCount = useMemo(
    () => (report ? report.shortCount + report.missingCount : 0),
    [report],
  );

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) {
      setError("Choose a BOM file first.");
      return;
    }

    setIsUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("bom", file);
      const response = await apiRequest("POST", "/api/bom/locate", formData);
      const nextReport = await response.json() as BomReport;
      setReport(nextReport);
      toast({
        title: "BOM report ready",
        description: `${nextReport.matchedCount} matched, ${nextReport.shortCount} short, ${nextReport.missingCount} missing.`,
      });
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "BOM upload failed.";
      setError(message);
      toast({
        title: "BOM report failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>BOM Locator</DialogTitle>
          <DialogDescription>
            Upload a BOM to match inventory locations and generate a printable grid report.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 border-b border-gray-200 pb-4 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <label htmlFor="bom-file" className="text-sm font-medium text-gray-700">
              BOM File
            </label>
            <Input
              id="bom-file"
              type="file"
              accept=".csv,.tsv,.txt,.json,text/csv,text/tab-separated-values,application/json"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setError(null);
              }}
            />
          </div>
          <Button type="submit" disabled={isUploading || !file} className="shrink-0">
            <Upload className="h-4 w-4" />
            {isUploading ? "Building..." : "Build Report"}
          </Button>
        </form>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Upload Failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {report && (
          <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-md border border-gray-200 bg-white p-3">
                  <p className="text-xs font-medium text-gray-500">Items</p>
                  <p className="text-xl font-semibold text-gray-900">{report.itemCount}</p>
                </div>
                <div className="rounded-md border border-green-200 bg-green-50 p-3">
                  <p className="text-xs font-medium text-green-700">Matched</p>
                  <p className="text-xl font-semibold text-green-800">{report.matchedCount}</p>
                </div>
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs font-medium text-amber-700">Short*</p>
                  <p className="text-xl font-semibold text-amber-800">{report.shortCount}</p>
                </div>
                <div className="rounded-md border border-red-200 bg-red-50 p-3">
                  <p className="text-xs font-medium text-red-700">Missing</p>
                  <p className="text-xl font-semibold text-red-800">{report.missingCount}</p>
                </div>
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                {report.htmlUrl && (
                  <Button asChild variant="default" className="shrink-0">
                    <a href={report.htmlUrl} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                      Web Report
                    </a>
                  </Button>
                )}
                <Button asChild variant={shortOrMissingCount > 0 ? "default" : "outline"} className="shrink-0">
                  <a href={report.pdfUrl} target="_blank" rel="noreferrer">
                    <Printer className="h-4 w-4" />
                    Open PDF
                  </a>
                </Button>
              </div>
            </div>

            {report.ai.used && report.ai.summary && (
              <Alert className="border-blue-200 bg-blue-50 text-blue-900">
                <Sparkles className="h-4 w-4" />
                <AlertTitle>AI Analysis</AlertTitle>
                <AlertDescription className="whitespace-pre-wrap">{report.ai.summary}</AlertDescription>
              </Alert>
            )}

            {report.ai.enabled && !report.ai.used && report.ai.error && (
              <Alert>
                <Sparkles className="h-4 w-4" />
                <AlertTitle>AI Analysis Unavailable</AlertTitle>
                <AlertDescription>{report.ai.error}</AlertDescription>
              </Alert>
            )}

            <div className="rounded-md border border-gray-200">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">#</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead className="w-24">Needed</TableHead>
                    <TableHead className="w-24">Have</TableHead>
                    <TableHead className="w-24">Match</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                    <TableHead>Location</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.items.map((item) => (
                    <TableRow key={item.itemNumber}>
                      <TableCell className="font-medium">
                        {item.itemNumber}{item.short ? "*" : ""}
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="font-medium text-gray-900">{item.name}</div>
                          {item.description && (
                            <div className="line-clamp-2 text-xs text-gray-500">{item.description}</div>
                          )}
                          {item.reference && (
                            <div className="text-xs text-gray-500">{item.reference}</div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{item.requiredQuantity}</TableCell>
                      <TableCell>{item.availableQuantity}</TableCell>
                      <TableCell>{item.matches.length > 0 ? `${item.confidence}%` : "-"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusClass(item.status)}>
                          {statusLabel(item)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-start gap-2 text-sm text-gray-700">
                          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                          <span>{locationSummary(item)}</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
