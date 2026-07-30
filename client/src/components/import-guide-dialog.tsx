import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Copy, Download, FileText, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ImportGuideDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function ImportGuideDialog({ isOpen, onClose }: ImportGuideDialogProps) {
  const { toast } = useToast();

  const exampleData = {
    cases: [
      {
        name: "Bench Components",
        model: "LAYOUT-6x4-BOTH",
        description: "Parts used during bring-up",
        compartments: [
          { id: 1, position: "A1", row: 1, col: 1, layer: "top" },
          { id: 2, position: "B3", row: 2, col: 3, layer: "bottom" }
        ]
      }
    ],
    components: [
      {
        compartmentId: 1,
        name: "10k Resistor",
        category: "resistor",
        packageSize: "0805",
        quantity: 100,
        minQuantity: 25,
        notes: "High precision 1%"
      },
      {
        compartmentId: 2,
        name: "BC547 Transistor",
        category: "transistor",
        packageSize: "TO-92",
        quantity: 50,
        minQuantity: 10,
        notes: "NPN general purpose"
      }
    ],
    tools: [
      {
        name: "Bench oscilloscope",
        category: "Oscilloscope",
        manufacturer: "Rigol",
        modelNumber: "DS1054Z",
        productUrl: "https://www.example.com/products/ds1054z",
        imageUrl: "https://www.example.com/images/ds1054z.jpg",
        quantity: 1,
        location: "Electronics bench",
        capabilities: "4 channels, 50 MHz, serial protocol decode",
        notes: "Includes four switchable 1x/10x probes"
      }
    ],
    adapters: [
      {
        name: "SOIC-8 to DIP-8 programming socket",
        category: "IC Package / Programming Adapter",
        manufacturer: "Example Electronics",
        modelNumber: "SOIC8-DIP8",
        productUrl: "https://www.example.com/products/soic8-dip8",
        imageUrl: "https://www.example.com/images/soic8-dip8.jpg",
        endpointA: "SOIC-8 socket",
        endpointAType: "soic",
        endpointB: "DIP-8 male header",
        endpointBType: "dip",
        quantity: 1,
        location: "Programmer adapter drawer",
        compatibility: "SOIC-8, 1.27 mm pitch, 3.9 mm body; passive DIP-8 output with 2.54 mm pitch",
        notes: "No level shifting or voltage protection; verify pin 1 and programmer voltage"
      }
    ],
    componentBooks: [
      {
        name: "0603 resistor sample book",
        manufacturer: "Example Electronics",
        packageSize: "0603",
        productUrl: "https://www.example.com/products/0603-resistor-book",
        imageUrl: "https://www.example.com/images/0603-resistor-book.jpg",
        description: "Assorted resistor values in labeled pages",
        items: [
          {
            name: "10 kΩ resistor",
            category: "Resistor",
            value: "10 kΩ",
            packageSize: "0603",
            quantity: 50
          }
        ]
      }
    ],
    version: "8.0"
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({
      title: "Copied to clipboard",
      description: "Example data copied successfully"
    });
  };

  const downloadTemplate = () => {
    const blob = new Blob([JSON.stringify(exampleData, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'electronics-catalog-template.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast({
      title: "Template downloaded",
      description: "Import template saved as electronics-catalog-template.json"
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <FileText className="h-5 w-5" />
            <span>Import Guide</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Overview */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-start space-x-3">
              <Info className="h-5 w-5 text-blue-600 mt-0.5" />
              <div>
                <h3 className="font-semibold text-blue-900">Import Format</h3>
                <p className="text-blue-700 text-sm mt-1">
                  Import cases, components, bench tools, adapters, and component books from a JSON catalog backup. The entire file is validated before any records are created.
                </p>
              </div>
            </div>
          </div>

          {/* Case Structure */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Case Properties</h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <h4 className="font-medium text-gray-900">Required Fields</h4>
                  <ul className="mt-2 space-y-1 text-sm">
                    <li><Badge variant="outline">name</Badge> - Case identifier</li>
                    <li><Badge variant="outline">model</Badge> - Layout type</li>
                    <li><Badge variant="outline">compartments</Badge> - Source positions and IDs</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-gray-900">Optional Fields</h4>
                  <ul className="mt-2 space-y-1 text-sm">
                    <li><Badge variant="secondary">description</Badge> - Case description</li>
                    <li><Badge variant="secondary">rows / cols</Badge> - Explicit layout dimensions</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* Available Models */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Available Case Models</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-white border rounded-lg p-3">
                <Badge className="mb-2">LAYOUT-12x6-BOTH</Badge>
                <p className="text-sm text-gray-600">12×6 grid on both layers (144 compartments)</p>
              </div>
              <div className="bg-white border rounded-lg p-3">
                <Badge className="mb-2">LAYOUT-6x4-TOP</Badge>
                <p className="text-sm text-gray-600">6×4 top + 12×6 bottom (96 compartments)</p>
              </div>
              <div className="bg-white border rounded-lg p-3">
                <Badge className="mb-2">LAYOUT-6x4-BOTH</Badge>
                <p className="text-sm text-gray-600">6×4 grid on both layers (48 compartments)</p>
              </div>
            </div>
          </div>

          <Separator />

          {/* Compartment Structure */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Compartment Properties</h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-sm text-gray-700">
                Every imported component points to a source compartment by ID. Each case's
                <Badge variant="outline" className="mx-1">compartments</Badge>
                array supplies that unique <Badge variant="outline">id</Badge>, plus
                <Badge variant="outline" className="mx-1">position</Badge>,
                <Badge variant="outline">row</Badge>,
                <Badge variant="outline" className="mx-1">col</Badge>, and
                <Badge variant="outline" className="ml-1">layer</Badge>.
              </p>
            </div>
          </div>

          {/* Component Structure */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Component Properties</h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <h4 className="font-medium text-gray-900">Required Fields</h4>
                  <ul className="mt-2 space-y-1 text-sm">
                    <li><Badge variant="outline">compartmentId</Badge> - Source compartment ID</li>
                    <li><Badge variant="outline">name</Badge> - Component name</li>
                    <li><Badge variant="outline">category</Badge> - Component type</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-gray-900">Optional Fields</h4>
                  <ul className="mt-2 space-y-1 text-sm">
                    <li><Badge variant="secondary">packageSize</Badge> - Physical package</li>
                    <li><Badge variant="secondary">quantity</Badge> - Stock count</li>
                    <li><Badge variant="secondary">minQuantity</Badge> - Reorder threshold</li>
                    <li><Badge variant="secondary">notes</Badge> - Additional info</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* Tool Structure */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Tool Properties</h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <h4 className="font-medium text-gray-900">Required Fields</h4>
                  <ul className="mt-2 space-y-1 text-sm">
                    <li><Badge variant="outline">name</Badge> - Tool or accessory name</li>
                    <li><Badge variant="outline">category</Badge> - Equipment type</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-gray-900">Optional Fields</h4>
                  <ul className="mt-2 space-y-1 text-sm">
                    <li><Badge variant="secondary">manufacturer / modelNumber</Badge></li>
                    <li><Badge variant="secondary">productUrl / imageUrl</Badge></li>
                    <li><Badge variant="secondary">quantity / location</Badge></li>
                    <li><Badge variant="secondary">capabilities</Badge> - Ratings and supported measurements</li>
                    <li><Badge variant="secondary">notes</Badge> - Probes, adapters, or setup details</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* Adapter Structure */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Adapter Properties</h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <h4 className="font-medium text-gray-900">Required Fields</h4>
                  <ul className="mt-2 space-y-1 text-sm">
                    <li><Badge variant="outline">name</Badge> - Adapter, socket, or breakout name</li>
                    <li><Badge variant="outline">category</Badge> - Adapter type</li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-gray-900">Optional Fields</h4>
                  <ul className="mt-2 space-y-1 text-sm">
                    <li><Badge variant="secondary">manufacturer / modelNumber</Badge></li>
                    <li><Badge variant="secondary">productUrl / imageUrl</Badge></li>
                    <li><Badge variant="secondary">endpointA / endpointB</Badge> - Optional paired physical labels displayed as A → B</li>
                    <li><Badge variant="secondary">endpointAType / endpointBType</Badge> - One of qfp, qfn, soic, dip, d-sub, terminal-block, usb, pin-header, debug-header, power, cable, or other</li>
                    <li><Badge variant="secondary">quantity / location</Badge></li>
                    <li><Badge variant="secondary">compatibility</Badge> - Connectors, gender, pitch, package, pinout, voltage, and supported targets</li>
                    <li><Badge variant="secondary">notes</Badge> - Passive/active behavior and safety limits</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* Component Book Structure */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Component Book Properties</h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <h4 className="font-medium text-gray-900">Book Fields</h4>
                  <ul className="mt-2 space-y-1 text-sm">
                    <li><Badge variant="outline">name</Badge> - Book name</li>
                    <li><Badge variant="outline">items</Badge> - Included component entries</li>
                    <li><Badge variant="secondary">packageSize</Badge> - Prominent book package</li>
                    <li><Badge variant="secondary">manufacturer / productUrl / imageUrl</Badge></li>
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-gray-900">Item Fields</h4>
                  <ul className="mt-2 space-y-1 text-sm">
                    <li><Badge variant="outline">name</Badge> - Included component name</li>
                    <li><Badge variant="secondary">category / partNumber</Badge></li>
                    <li><Badge variant="secondary">value / packageSize / quantity</Badge></li>
                    <li><Badge variant="secondary">notes</Badge> - Item-specific details</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* Component Categories */}
          <div>
            <h3 className="text-lg font-semibold mb-3">Component Categories</h3>
            <div className="flex flex-wrap gap-2">
              {[
                "resistor", "capacitor", "inductor", "transistor", "diode",
                "ic", "crystal", "connector", "switch", "led", "sensor", "other"
              ].map(category => (
                <Badge key={category} variant="outline" className="text-xs">
                  {category}
                </Badge>
              ))}
            </div>
          </div>

          <Separator />

          {/* Example Data */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">Example Import Data</h3>
              <div className="flex space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyToClipboard(JSON.stringify(exampleData, null, 2))}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={downloadTemplate}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download Template
                </Button>
              </div>
            </div>

            <div className="bg-gray-900 text-gray-100 rounded-lg p-4 overflow-x-auto">
              <pre className="text-sm">
                {JSON.stringify(exampleData, null, 2)}
              </pre>
            </div>
          </div>

          {/* Tips */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <h4 className="font-semibold text-amber-900 mb-2">Import Tips</h4>
            <ul className="text-amber-800 text-sm space-y-1">
              <li>• Compartment IDs must be unique across every case in the import file</li>
              <li>• Position format is letter + number (A1, B12, F3, etc.)</li>
              <li>• Choose Replace to swap the existing catalog after all new records are staged</li>
              <li>• Older files without a tools array leave the current tool catalog unchanged</li>
              <li>• Older files without an adapters array leave the current adapter catalog unchanged</li>
              <li>• Older adapter records without endpoint fields remain importable and show an unrecorded endpoint until edited</li>
              <li>• Older files without a componentBooks array leave component books unchanged</li>
              <li>• Invalid references or missing required fields reject the whole import before changes begin</li>
            </ul>
          </div>

          <div className="flex justify-end">
            <Button onClick={onClose}>
              Got it!
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
