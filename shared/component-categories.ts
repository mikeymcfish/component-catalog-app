export const COMPONENT_CATEGORY_VALUES = [
  "resistor",
  "capacitor",
  "ic",
  "diode",
  "transistor",
  "inductor",
  "crystal",
  "connector",
  "led",
  "switch",
  "sensor",
  "other",
] as const;

export type ComponentCategory = (typeof COMPONENT_CATEGORY_VALUES)[number];

export const COMPONENT_CATEGORY_BY_ID = new Map<number, ComponentCategory>(
  COMPONENT_CATEGORY_VALUES.map((category, index) => [index + 1, category]),
);

const CATEGORY_ALIASES: Record<string, ComponentCategory> = {
  resistor: "resistor",
  resistors: "resistor",
  capacitor: "capacitor",
  capacitors: "capacitor",
  cap: "capacitor",
  caps: "capacitor",
  ic: "ic",
  chip: "ic",
  chips: "ic",
  diode: "diode",
  diodes: "diode",
  transistor: "transistor",
  transistors: "transistor",
  inductor: "inductor",
  inductors: "inductor",
  coil: "inductor",
  crystal: "crystal",
  oscillator: "crystal",
  connector: "connector",
  connectors: "connector",
  led: "led",
  leds: "led",
  switch: "switch",
  switches: "switch",
  sensor: "sensor",
  sensors: "sensor",
};

export function inferComponentCategory(words: string[]) {
  for (const word of words) {
    const category = CATEGORY_ALIASES[word];
    if (category) return category;
  }
  return undefined;
}

export function isCategoryWord(word: string) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_ALIASES, word);
}
