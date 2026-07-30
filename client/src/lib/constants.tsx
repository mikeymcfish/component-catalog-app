export const COMPONENT_CATEGORIES = [
  { value: "resistor", label: "Resistor", color: "#E91E63" },
  { value: "capacitor", label: "Capacitor", color: "#9C27B0" },
  { value: "ic", label: "Integrated Circuit", color: "#3F51B5" },
  { value: "diode", label: "Diode", color: "#FF5722" },
  { value: "transistor", label: "Transistor", color: "#FF9800" },
  { value: "inductor", label: "Inductor", color: "#795548" },
  { value: "crystal", label: "Crystal/Oscillator", color: "#607D8B" },
  { value: "connector", label: "Connector", color: "#009688" },
  { value: "led", label: "LED", color: "#FFEB3B" },
  { value: "switch", label: "Switch", color: "#4CAF50" },
  { value: "sensor", label: "Sensor", color: "#2196F3" },
  { value: "other", label: "Other", color: "#9E9E9E" },
];

export const PACKAGE_SIZES = [
  "0201",
  "0402",
  "0603",
  "0805",
  "1206",
  "1210",
  "1812",
  "2010",
  "2512",
  "SOT-23",
  "SOT-23-3",
  "SOT-23-5",
  "SOT-23-6",
  "SOT-89",
  "SOT-223",
  "SOIC-8",
  "SOIC-14",
  "SOIC-16",
  "SOIC-20",
  "SSOP-16",
  "SSOP-20",
  "SSOP-28",
  "TQFP-32",
  "TQFP-44",
  "TQFP-64",
  "TQFP-100",
  "BGA",
  "QFN-16",
  "QFN-20",
  "QFN-24",
  "QFN-28",
  "QFN-32",
  "WLCSP",
  "TO-220",
  "TO-252",
  "TO-263",
];

export const CASE_LAYOUTS = {
  "BOX-ALL-144": {
    rows: 6,
    cols: 12,
    totalCompartments: 144,
    dimensions: "8.7\" × 5.7\" × 1.5\"",
    description: "Uniform compartments on both layers"
  },
  "BOX-ALL-96": {
    rows: 6,
    cols: 12,
    totalCompartments: 96,
    dimensions: "8.7\" × 5.7\" × 1.5\"",
    description: "Mixed compartment sizes"
  },
  "BOX-ALL-48": {
    rows: 4,
    cols: 6,
    totalCompartments: 48,
    dimensions: "8.7\" × 5.7\" × 1.5\"",
    description: "24 small (top) + 24 large (bottom)"
  },
  "BOX-ALL-24": {
    rows: 2,
    cols: 6,
    totalCompartments: 24,
    dimensions: "9\" × 6\" × 2.5\"",
    description: "Three sizes: small, medium, large"
  },
  "LAYOUT-12x6-BOTH": {
    rows: 6,
    cols: 12,
    totalCompartments: 144,
    description: "12×6 Both Layers (uniform squares)"
  },
  "LAYOUT-6x4-TOP": {
    rows: 4,
    cols: 6,
    totalCompartments: 48,
    description: "6×4 Top + 12×6 Bottom (mixed)",
    isMixed: true
  },
  "LAYOUT-6x4-BOTH": {
    rows: 4,
    cols: 6,
    totalCompartments: 48,
    description: "6×4 Both Layers (tall rectangles)",
    isTall: true
  }
};
